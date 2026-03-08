import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { marked } from 'marked';
import { Markdown } from 'tiptap-markdown';

const state = window.__MDVIEW__;
const layout = document.getElementById('layout');
const docRoot = document.getElementById('docRoot');
const tocRoot = document.getElementById('toc');
const pageTitle = document.getElementById('pageTitle');
const fileTreeRoot = document.getElementById('fileTree');
const themeToggle = document.getElementById('themeToggle');
const searchTrigger = document.getElementById('searchTrigger');
const searchPalette = document.getElementById('searchPalette');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const sidebarToggle = document.getElementById('sidebarToggle');
const feedbackList = document.getElementById('feedbackList');
const feedbackCount = document.getElementById('feedbackCount');
const feedbackMeta = document.getElementById('feedbackMeta');
const sendFeedbackButton = document.getElementById('sendFeedbackButton');
const addBlockButton = document.getElementById('addBlockButton');
const floatingToolbarRoot = document.getElementById('floatingToolbarRoot');
const composerRoot = document.getElementById('composerRoot');
const statusToast = document.getElementById('statusToast');
const html = document.documentElement;

const SLASH_COMMANDS = [
  { id: 'heading-2', label: 'Heading 2', detail: 'Large section heading', run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'heading-3', label: 'Heading 3', detail: 'Sub-section heading', run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet-list', label: 'Bullet List', detail: 'Create a bulleted list', run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'task-list', label: 'Task List', detail: 'Checklist with completion states', run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'code-block', label: 'Code Block', detail: 'Monospace fenced code block', run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'table', label: 'Table', detail: 'Insert a 3x3 table', run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'divider', label: 'Divider', detail: 'Horizontal rule', run: (editor) => editor.chain().focus().setHorizontalRule().run() },
];

let currentDoc = state.initialDoc;
let feedbackState = state.initialFeedback;
let socket = null;
let activeEditor = null;
let activeComposer = null;
let selectedResult = 0;
let toastTimer = null;

applyStoredTheme();
init();

function init() {
  renderFromDoc(currentDoc);
  renderFeedback(feedbackState);
  bindEvents();
  syncThemeWithDocument();
  hydrateFromHash();
  connectSocket();
}

function bindEvents() {
  themeToggle?.addEventListener('click', toggleTheme);
  searchTrigger?.addEventListener('click', openSearch);
  sidebarToggle?.addEventListener('click', () => layout.classList.toggle('sidebar-open'));
  sendFeedbackButton?.addEventListener('click', sendFeedback);
  addBlockButton?.addEventListener('click', startAddBlock);

  document.addEventListener('keydown', async (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
      return;
    }

    if (event.key === 'Escape') {
      if (!searchPalette.classList.contains('hidden')) {
        closeSearch();
        return;
      }
      if (activeComposer) {
        closeComposer();
        return;
      }
      if (activeEditor) {
        cancelEdit();
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && activeEditor) {
      event.preventDefault();
      await saveEdit();
    }
  });

  document.addEventListener('pointerdown', async (event) => {
    if (!activeEditor) {
      return;
    }

    if (event.target.closest('.editor-shell, .floating-toolbar, .composer, .slash-menu')) {
      return;
    }

    await saveEdit();
  });

  searchPalette.addEventListener('click', (event) => {
    if (event.target.dataset.closeSearch === 'true') {
      closeSearch();
    }
  });

  searchInput.addEventListener('input', () => {
    selectedResult = 0;
    renderSearchResults(searchInput.value);
  });

  searchInput.addEventListener('keydown', (event) => {
    const buttons = [...searchResults.querySelectorAll('.search-result')];
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedResult = Math.min(selectedResult + 1, Math.max(buttons.length - 1, 0));
      syncSelectedResult(buttons);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedResult = Math.max(selectedResult - 1, 0);
      syncSelectedResult(buttons);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      buttons[selectedResult]?.click();
    }
  });

  tocRoot?.addEventListener('click', (event) => {
    const anchor = event.target.closest('[data-jump-id]');
    if (!anchor) {
      return;
    }
    event.preventDefault();
    jumpToTarget({ headingId: anchor.dataset.jumpId });
  });

  docRoot.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('.copy-code');
    if (copyButton) {
      const code = copyButton.parentElement.querySelector('pre code');
      const text = code ? code.innerText : '';
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copied';
      setTimeout(() => {
        copyButton.textContent = 'Copy';
      }, 1200);
      return;
    }

    const reaction = event.target.closest('[data-feedback-type]');
    if (reaction) {
      event.preventDefault();
      const block = reaction.closest('.md-block');
      handleHeadingReaction(block, reaction.dataset.feedbackType, reaction);
      return;
    }
  });

  docRoot.addEventListener('dblclick', async (event) => {
    if (!state.editable || activeEditor) {
      return;
    }

    if (event.target.closest('button, input, textarea')) {
      return;
    }

    const block = event.target.closest('.md-block');
    if (!block) {
      return;
    }

    enterEditMode(block);
  });

  feedbackList?.addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('[data-delete-feedback-id]');
    if (deleteButton) {
      event.stopPropagation();
      await deleteFeedback(deleteButton.dataset.deleteFeedbackId);
      return;
    }

    const item = event.target.closest('[data-feedback-anchor]');
    if (!item) {
      return;
    }

    const feedbackId = item.dataset.feedbackId;
    const change = feedbackState.changes.find((entry) => entry.id === feedbackId);
    if (change) {
      jumpToTarget(change.anchor || { line: change.line, headingId: change.anchor?.headingId, blockId: change.anchor?.blockId });
    }
  });

  window.addEventListener('popstate', async (event) => {
    if (event.state?.path) {
      await loadDocument(event.state.path, false);
    }
  });
}

function renderFromDoc(doc) {
  currentDoc = {
    ...doc,
    blocks: (doc.blocks || []).map((block) => ({
      ...block,
      previewHtml: renderSearchPreview(block.markdown),
    })),
  };
  docRoot.innerHTML = currentDoc.html;
  pageTitle.textContent = currentDoc.title;
  document.title = currentDoc.title;
  renderToc(currentDoc.toc);
  renderFiles(state.fileTree || []);
  decorateDocument();
  clearSearchHighlights();
}

function renderToc(items) {
  tocRoot.innerHTML = items.map((item) => (
    `<a href="#${escapeAttribute(item.id)}" data-jump-id="${escapeAttribute(item.id)}" data-depth="${item.depth}">${escapeHtml(item.text)}</a>`
  )).join('');
}

function renderFiles(files) {
  if (!fileTreeRoot) {
    return;
  }

  fileTreeRoot.innerHTML = files.map((entry) => {
    const active = entry.relative === currentDoc.relativePath ? ' is-active' : '';
    return `<button class="${active.trim()}" data-file-path="${escapeAttribute(entry.relative)}">${escapeHtml(entry.relative)}</button>`;
  }).join('');

  fileTreeRoot.querySelectorAll('button[data-file-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      layout.classList.remove('sidebar-open');
      await loadDocument(button.dataset.filePath, true);
    });
  });
}

function renderFeedback(feedback) {
  feedbackState = feedback;
  feedbackCount.textContent = String(feedback.changes.length);
  feedbackMeta.textContent = feedback.reviewedAt
    ? `Reviewed ${new Date(feedback.reviewedAt).toLocaleString()}`
    : 'Changes, comments, approvals, and rejections live here.';

  if (feedback.changes.length === 0) {
    feedbackList.innerHTML = '<div class="feedback-empty">No feedback yet. Select text or react to a section to add structured notes.</div>';
    return;
  }

  feedbackList.innerHTML = feedback.changes.map((change) => {
    const badge = changeLabel(change.type);
    const body = feedbackBody(change);
    return `
      <article class="feedback-item" data-feedback-id="${escapeAttribute(change.id)}" data-feedback-anchor="true">
        <div class="feedback-item__header">
          <div class="feedback-item__badge">${escapeHtml(badge)}</div>
          <button class="feedback-item__delete" type="button" data-delete-feedback-id="${escapeAttribute(change.id)}">x</button>
        </div>
        <div class="feedback-item__section">${escapeHtml(change.section || currentDoc.title)}</div>
        <div class="feedback-item__body">${body}</div>
      </article>
    `;
  }).join('');
}

function changeLabel(type) {
  switch (type) {
    case 'approve':
      return 'Approve';
    case 'reject':
      return 'Reject';
    case 'edit':
      return 'Edit';
    case 'added':
      return 'Added';
    default:
      return 'Comment';
  }
}

function feedbackBody(change) {
  if (change.type === 'edit') {
    return `<strong>Before:</strong> ${escapeHtml((change.before || '').slice(0, 180))}<br /><strong>After:</strong> ${escapeHtml((change.after || '').slice(0, 180))}`;
  }

  if (change.type === 'added') {
    return escapeHtml((change.content || '').slice(0, 220));
  }

  const pieces = [];
  if (change.selectedText) {
    pieces.push(`<strong>${escapeHtml(change.selectedText)}</strong>`);
  }
  if (change.comment) {
    pieces.push(escapeHtml(change.comment));
  }
  return pieces.join('<br />') || '<em>No note</em>';
}

function decorateDocument() {
  docRoot.querySelectorAll('.heading-reactions').forEach((node) => node.remove());

  docRoot.querySelectorAll('.md-block--heading[data-heading-depth="2"], .md-block--heading[data-heading-depth="3"]').forEach((block) => {
    const reactions = document.createElement('div');
    reactions.className = 'heading-reactions';
    reactions.innerHTML = `
      <button type="button" data-feedback-type="approve">Approve</button>
      <button type="button" data-feedback-type="reject">Reject</button>
      <button type="button" data-feedback-type="comment">Comment</button>
    `;
    block.appendChild(reactions);
  });
}

async function hydrateFromHash() {
  if (state.mode !== 'directory' || !location.hash.startsWith('#file=')) {
    return;
  }

  const nextPath = decodeURIComponent(location.hash.slice('#file='.length));
  if (nextPath && nextPath !== currentDoc.relativePath) {
    await loadDocument(nextPath, false);
  }
}

async function loadDocument(relativePath, pushHistory = false) {
  cancelEdit({ restore: false });
  closeComposer();
  const scroll = window.scrollY;
  const response = await fetch(`/api/doc?path=${encodeURIComponent(relativePath)}&theme=${encodeURIComponent(currentTheme())}`);
  if (!response.ok) {
    showToast('Unable to load document');
    return;
  }

  const doc = await response.json();
  renderFromDoc(doc);
  state.currentPath = doc.relativePath;
  await loadFeedback();

  if (pushHistory) {
    history.pushState({ path: relativePath, scroll }, '', `#file=${encodeURIComponent(relativePath)}`);
  }

  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
}

function connectSocket() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws`);

  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === 'file-changed') {
      if (activeEditor) {
        return;
      }
      const changedRelative = toRelativePath(payload.currentPath || payload.path);
      if (!changedRelative || changedRelative === state.currentPath) {
        await refreshCurrentDocument(true);
      }
      return;
    }

    if (payload.type === 'directory-changed') {
      state.fileTree = payload.files;
      renderFiles(state.fileTree);
      const changedRelative = toRelativePath(payload.path);
      if (!activeEditor && changedRelative === state.currentPath) {
        await refreshCurrentDocument(true);
      }
      return;
    }

    if (payload.type === 'feedback-changed' || payload.type === 'feedback-submitted') {
      if (toRelativePath(payload.feedbackPath || payload.path) === state.currentPath || !payload.relativePath || payload.relativePath === state.currentPath) {
        await loadFeedback();
      }
    }
  });

  socket.addEventListener('close', () => {
    setTimeout(connectSocket, 700);
  });
}

async function refreshCurrentDocument(preserveScroll) {
  const scroll = window.scrollY;
  const response = await fetch(`/api/doc?path=${encodeURIComponent(state.currentPath)}&theme=${encodeURIComponent(currentTheme())}`);
  if (!response.ok) {
    return;
  }

  const nextDoc = await response.json();
  renderFromDoc(nextDoc);
  if (preserveScroll) {
    requestAnimationFrame(() => window.scrollTo({ top: scroll }));
  }
}

function enterEditMode(block, options = {}) {
  if (!state.editable) {
    return;
  }

  if (activeEditor) {
    cancelEdit();
  }

  const mode = options.mode || 'replace';
  const originalHTML = block.innerHTML;
  const originalMarkdown = mode === 'replace' ? (block.dataset.markdown || '') : '';
  const section = block.dataset.section || currentDoc.blocks.find((entry) => entry.id === block.dataset.blockId)?.section || currentDoc.title;
  const shell = document.createElement('div');
  const host = document.createElement('div');
  const actions = document.createElement('div');

  shell.className = 'editor-shell';
  host.className = 'editor-host';
  actions.className = 'editor-shell__toolbar';
  actions.innerHTML = `
    <div class="editor-shell__hint">Visual editing enabled. Select text for formatting and comments. Type / for blocks.</div>
    <div class="editor-shell__actions">
      <button type="button" data-editor-cancel="true">Cancel</button>
      <button type="button" class="primary" data-editor-save="true">Save Cmd+Enter</button>
    </div>
  `;
  shell.appendChild(actions);
  shell.appendChild(host);

  block.classList.add('is-editing');
  docRoot.classList.add('is-editing');
  block.innerHTML = '';
  block.appendChild(shell);

  let editor;

  try {
    editor = new Editor({
      element: host,
      content: originalMarkdown,
      extensions: [
        StarterKit.configure({
          link: false,
        }),
        Link.configure({
          autolink: true,
          openOnClick: false,
          HTMLAttributes: {
            rel: 'noreferrer noopener',
            target: '_blank',
          },
        }),
        TableKit.configure({
          table: {
            resizable: true,
            renderWrapper: true,
            allowTableNodeSelection: true,
          },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: options.placeholder || 'Type / for commands, or start writing…',
        }),
        Markdown.configure({
          html: true,
          linkify: true,
          transformPastedText: true,
        }),
      ],
      autofocus: 'end',
      onSelectionUpdate: () => {
        syncFloatingToolbar();
        syncSlashMenu();
      },
      onUpdate: () => {
        syncFloatingToolbar();
        syncSlashMenu();
      },
    });
  } catch (error) {
    console.error('Failed to initialize TipTap editor.', {
      error,
      blockId: block.dataset.blockId,
      blockType: block.dataset.blockType,
      mode,
      markdown: originalMarkdown,
    });
    closeFloatingToolbar();
    closeSlashMenu();
    closeComposer();
    docRoot.classList.remove('is-editing');
    block.classList.remove('is-editing');

    if (mode === 'insert') {
      block.remove();
    } else {
      block.innerHTML = originalHTML;
    }

    showToast('Unable to start visual editor. Check console.');
    return;
  }

  actions.addEventListener('click', async (event) => {
    if (event.target.dataset.editorCancel === 'true') {
      cancelEdit();
    }
    if (event.target.dataset.editorSave === 'true') {
      await saveEdit();
    }
  });

  host.addEventListener('keydown', (event) => {
    if (!activeEditor?.slashState) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeEditor.slashIndex = Math.min(activeEditor.slashIndex + 1, activeEditor.slashState.items.length - 1);
      renderSlashMenu();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeEditor.slashIndex = Math.max(activeEditor.slashIndex - 1, 0);
      renderSlashMenu();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      applySlashCommand(activeEditor.slashState.items[activeEditor.slashIndex]);
    } else if (event.key === 'Escape') {
      closeSlashMenu();
    }
  });

  activeEditor = {
    block,
    editor,
    mode,
    originalHTML,
    originalMarkdown,
    section,
    toolbar: null,
    slashMenu: null,
    slashState: null,
    slashIndex: 0,
  };

  syncFloatingToolbar();
  syncSlashMenu();
}

function startAddBlock() {
  if (activeEditor) {
    cancelEdit();
  }

  const block = document.createElement('section');
  block.className = 'md-block md-block--paragraph';
  block.dataset.blockId = `new-${Date.now()}`;
  block.dataset.startLine = String(currentDoc.lineCount + 1);
  block.dataset.endLine = String(currentDoc.lineCount);
  block.dataset.blockType = 'paragraph';
  block.dataset.section = currentDoc.blocks.at(-1)?.section || currentDoc.title;
  block.dataset.markdown = '';
  docRoot.appendChild(block);
  block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  enterEditMode(block, { mode: 'insert', placeholder: 'Start a new section, paragraph, table, or list…' });
}

function cancelEdit(options = {}) {
  if (!activeEditor) {
    return;
  }

  const { block, editor, originalHTML, mode } = activeEditor;
  editor?.destroy();
  closeFloatingToolbar();
  closeSlashMenu();
  closeComposer();
  docRoot.classList.remove('is-editing');

  if (mode === 'insert' && options.restore !== false) {
    block.remove();
  } else if (mode === 'insert' && options.restore === false) {
    block.remove();
  } else {
    block.innerHTML = originalHTML;
    block.classList.remove('is-editing');
  }

  activeEditor = null;
}

async function saveEdit() {
  if (!activeEditor) {
    return;
  }

  const markdownStorage = activeEditor.editor.storage.markdown;
  if (!markdownStorage?.getMarkdown) {
    console.error('Markdown serializer is unavailable on the active editor.', activeEditor);
    showToast('Unable to save: markdown serializer unavailable.');
    return;
  }

  const markdown = normalizeSerializedMarkdown(markdownStorage.getMarkdown());
  const payload = {
    path: currentDoc.relativePath,
    startLine: Number(activeEditor.block.dataset.startLine),
    endLine: Number(activeEditor.block.dataset.endLine),
    content: markdown,
    section: activeEditor.section,
    anchor: {
      blockId: activeEditor.block.dataset.blockId,
      headingId: activeEditor.block.dataset.headingId || null,
      line: Number(activeEditor.block.dataset.startLine),
    },
  };

  const response = await fetch('/api/save', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    showToast('Unable to save');
    return;
  }

  cancelEdit({ restore: false });
  await refreshCurrentDocument(true);
  await loadFeedback();
  showToast('Saved');
}

function normalizeSerializedMarkdown(markdown) {
  return markdown.replace(/\s+$/, '');
}

function syncFloatingToolbar() {
  if (!activeEditor) {
    return;
  }

  const { editor } = activeEditor;
  const { selection } = editor.state;

  if (selection.empty) {
    closeFloatingToolbar();
    return;
  }

  if (!activeEditor.toolbar) {
    const toolbar = document.createElement('div');
    toolbar.className = 'floating-toolbar';
    toolbar.innerHTML = `
      <button type="button" data-command="bold"><strong>B</strong></button>
      <button type="button" data-command="italic"><em>I</em></button>
      <button type="button" data-command="link">Link</button>
      <button type="button" data-command="comment">Comment</button>
    `;
    toolbar.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-command]');
      if (!button) {
        return;
      }

      const command = button.dataset.command;
      if (command === 'bold') {
        editor.chain().focus().toggleBold().run();
      } else if (command === 'italic') {
        editor.chain().focus().toggleItalic().run();
      } else if (command === 'link') {
        const currentHref = editor.getAttributes('link').href || 'https://';
        const href = window.prompt('Link URL', currentHref);
        if (!href) {
          editor.chain().focus().unsetLink().run();
        } else {
          editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
        }
      } else if (command === 'comment') {
        const currentSelection = editor.state.selection;
        const selectedText = editor.state.doc.textBetween(currentSelection.from, currentSelection.to, ' ').trim();
        const rect = toolbar.getBoundingClientRect();
        openComposer({
          x: rect.left,
          y: rect.bottom + 12,
          title: 'Comment on selection',
          meta: selectedText,
          placeholder: 'Explain what should change',
          onSubmit: async (comment) => {
            await submitFeedbackChange({
              type: 'comment',
              section: activeEditor.section,
              selectedText,
              comment,
              line: Number(activeEditor.block.dataset.startLine),
              anchor: {
                blockId: activeEditor.block.dataset.blockId,
                headingId: activeEditor.block.dataset.headingId || null,
                line: Number(activeEditor.block.dataset.startLine),
              },
            });
          },
        });
      }
      syncFloatingToolbar();
    });
    floatingToolbarRoot.appendChild(toolbar);
    activeEditor.toolbar = toolbar;
  }

  const from = editor.view.coordsAtPos(selection.from);
  const to = editor.view.coordsAtPos(selection.to);
  const left = Math.max(12, Math.min((from.left + to.right) / 2 - activeEditor.toolbar.offsetWidth / 2, window.innerWidth - activeEditor.toolbar.offsetWidth - 12));
  const top = Math.max(12, from.top - 58);

  activeEditor.toolbar.style.left = `${left}px`;
  activeEditor.toolbar.style.top = `${top}px`;

  activeEditor.toolbar.querySelector('[data-command="bold"]').dataset.active = String(editor.isActive('bold'));
  activeEditor.toolbar.querySelector('[data-command="italic"]').dataset.active = String(editor.isActive('italic'));
  activeEditor.toolbar.querySelector('[data-command="link"]').dataset.active = String(editor.isActive('link'));
}

function closeFloatingToolbar() {
  if (!activeEditor?.toolbar) {
    return;
  }

  activeEditor.toolbar.remove();
  activeEditor.toolbar = null;
}

function syncSlashMenu() {
  if (!activeEditor) {
    return;
  }

  const slashState = getSlashState(activeEditor.editor);
  if (!slashState) {
    closeSlashMenu();
    return;
  }

  activeEditor.slashState = slashState;
  if (!activeEditor.slashMenu) {
    const menu = document.createElement('div');
    menu.className = 'slash-menu';
    activeEditor.slashMenu = menu;
    document.body.appendChild(menu);
  }

  const coords = activeEditor.editor.view.coordsAtPos(activeEditor.editor.state.selection.from);
  activeEditor.slashMenu.style.left = `${Math.max(12, Math.min(coords.left, window.innerWidth - 292))}px`;
  activeEditor.slashMenu.style.top = `${coords.bottom + 10}px`;
  renderSlashMenu();
}

function renderSlashMenu() {
  if (!activeEditor?.slashMenu || !activeEditor?.slashState) {
    return;
  }

  activeEditor.slashMenu.innerHTML = activeEditor.slashState.items.map((item, index) => `
    <button type="button" class="${index === activeEditor.slashIndex ? 'is-active' : ''}" data-slash-command="${escapeAttribute(item.id)}">
      ${escapeHtml(item.label)}
      <small>${escapeHtml(item.detail)}</small>
    </button>
  `).join('');

  activeEditor.slashMenu.querySelectorAll('[data-slash-command]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = activeEditor.slashState.items.find((entry) => entry.id === button.dataset.slashCommand);
      applySlashCommand(item);
    });
  });
}

function closeSlashMenu() {
  if (!activeEditor) {
    return;
  }

  activeEditor.slashState = null;
  activeEditor.slashIndex = 0;
  if (activeEditor.slashMenu) {
    activeEditor.slashMenu.remove();
    activeEditor.slashMenu = null;
  }
}

function getSlashState(editor) {
  const { selection } = editor.state;
  if (!selection.empty) {
    return null;
  }

  const { $from } = selection;
  if (!$from.parent.isTextblock) {
    return null;
  }

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, ' ', ' ');
  const match = textBefore.match(/^\/([a-z0-9 -]*)$/i);
  if (!match) {
    return null;
  }

  const query = match[1].trim().toLowerCase();
  const items = SLASH_COMMANDS.filter((item) => {
    if (!query) {
      return true;
    }
    const haystack = `${item.label} ${item.detail}`.toLowerCase();
    return haystack.includes(query);
  });

  if (items.length === 0) {
    return null;
  }

  const from = selection.from - textBefore.length;
  return { from, to: selection.from, items };
}

function applySlashCommand(item) {
  if (!item || !activeEditor?.slashState) {
    return;
  }

  activeEditor.editor.chain().focus().deleteRange({ from: activeEditor.slashState.from, to: activeEditor.slashState.to }).run();
  item.run(activeEditor.editor);
  closeSlashMenu();
  activeEditor.editor.commands.focus();
}

function openComposer({ x, y, title, meta, placeholder, onSubmit }) {
  closeComposer();

  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.innerHTML = `
    <div class="composer__meta">${escapeHtml(title)}</div>
    ${meta ? `<div class="composer__meta">${escapeHtml(meta)}</div>` : ''}
    <textarea placeholder="${escapeAttribute(placeholder || '')}"></textarea>
    <div class="composer__actions">
      <button type="button" data-composer-cancel="true">Cancel</button>
      <button type="button" data-composer-save="true">Save</button>
    </div>
  `;

  composer.style.left = `${Math.max(12, Math.min(x, window.innerWidth - 380))}px`;
  composer.style.top = `${Math.max(12, Math.min(y, window.innerHeight - 240))}px`;
  composerRoot.appendChild(composer);

  const textarea = composer.querySelector('textarea');
  textarea.focus();

  const handleSave = async () => {
    await onSubmit(textarea.value.trim());
    closeComposer();
  };

  composer.addEventListener('click', async (event) => {
    if (event.target.dataset.composerCancel === 'true') {
      closeComposer();
    }
    if (event.target.dataset.composerSave === 'true') {
      await handleSave();
    }
  });

  activeComposer = composer;
}

function closeComposer() {
  if (!activeComposer) {
    return;
  }
  activeComposer.remove();
  activeComposer = null;
}

function handleHeadingReaction(block, type, trigger) {
  if (!block) {
    return;
  }

  const section = block.dataset.headingText || block.dataset.section || currentDoc.title;
  const anchor = {
    blockId: block.dataset.blockId,
    headingId: block.dataset.headingId || null,
    line: Number(block.dataset.startLine),
  };

  if (type === 'approve') {
    submitFeedbackChange({
      type,
      section,
      line: anchor.line,
      anchor,
    });
    return;
  }

  const rect = trigger.getBoundingClientRect();
  openComposer({
    x: rect.left,
    y: rect.bottom + 12,
    title: type === 'reject' ? 'Why reject this section?' : 'Comment on section',
    meta: section,
    placeholder: type === 'reject' ? 'Describe what needs to change' : 'Add a targeted note',
    onSubmit: async (comment) => {
      await submitFeedbackChange({
        type,
        section,
        comment,
        line: anchor.line,
        anchor,
      });
    },
  });
}

async function submitFeedbackChange(payload) {
  const response = await fetch('/api/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: currentDoc.relativePath,
      ...payload,
    }),
  });

  if (!response.ok) {
    showToast('Unable to save feedback');
    return;
  }

  const feedback = await response.json();
  renderFeedback(feedback);
  showToast('Feedback saved');
}

async function deleteFeedback(id) {
  const response = await fetch(`/api/feedback/${encodeURIComponent(id)}?path=${encodeURIComponent(currentDoc.relativePath)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    showToast('Unable to delete feedback');
    return;
  }

  const feedback = await response.json();
  renderFeedback(feedback);
  showToast('Feedback removed');
}

async function loadFeedback() {
  const response = await fetch(`/api/feedback?path=${encodeURIComponent(state.currentPath)}`);
  if (!response.ok) {
    return;
  }

  const feedback = await response.json();
  renderFeedback(feedback);
}

async function sendFeedback() {
  const response = await fetch('/api/send-feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: currentDoc.relativePath,
    }),
  });

  if (!response.ok) {
    showToast('Unable to send feedback');
    return;
  }

  const feedback = await response.json();
  renderFeedback(feedback);
  showToast('Feedback sent');
}

function toggleTheme() {
  const next = html.dataset.theme === 'light' ? 'dark' : 'light';
  html.dataset.theme = next;
  localStorage.setItem('mdview-theme', next);
  refreshCurrentDocument(true);
}

function currentTheme() {
  return html.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyStoredTheme() {
  const saved = localStorage.getItem('mdview-theme');
  if (saved === 'light' || saved === 'dark') {
    html.dataset.theme = saved;
  }
}

function syncThemeWithDocument() {
  if (html.dataset.theme !== state.defaultTheme) {
    refreshCurrentDocument(false);
  }
}

function openSearch() {
  searchPalette.classList.remove('hidden');
  searchPalette.setAttribute('aria-hidden', 'false');
  searchInput.value = '';
  selectedResult = 0;
  renderSearchResults('');
  setTimeout(() => searchInput.focus(), 0);
}

function closeSearch() {
  searchPalette.classList.add('hidden');
  searchPalette.setAttribute('aria-hidden', 'true');
  clearSearchHighlights();
}

function renderSearchResults(query) {
  const normalized = query.trim().toLowerCase();
  const entries = buildSearchEntries(normalized);

  clearSearchHighlights();
  if (normalized) {
    docRoot.querySelectorAll('.md-block').forEach((block) => {
      if ((block.dataset.searchText || '').toLowerCase().includes(normalized)) {
        block.classList.add('is-search-hit');
      }
    });
  }

  searchResults.innerHTML = entries.map((item, index) => `
    <button class="search-result ${index === selectedResult ? 'is-selected' : ''}" data-search-index="${index}">
      <div class="search-result__header">
        <span>${escapeHtml(item.kind)} · ${escapeHtml(item.section || currentDoc.title)}</span>
        <span>Line ${item.startLine}</span>
      </div>
      <div class="search-result__preview">${item.previewHtml}</div>
    </button>
  `).join('');

  searchResults.querySelectorAll('[data-search-index]').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = entries[Number(button.dataset.searchIndex)];
      closeSearch();
      jumpToTarget(entry.anchor);
    });
  });
}

function buildSearchEntries(query) {
  const base = currentDoc.blocks.map((block) => {
    const kind = block.heading ? 'Heading' : 'Content';
    const score = query ? fuzzyScore(query, (block.searchText || '').toLowerCase()) : 1;
    return {
      score,
      kind,
      section: block.section,
      startLine: block.startLine,
      previewHtml: block.previewHtml,
      anchor: {
        blockId: block.id,
        headingId: block.heading?.id || block.heading?.slug || null,
        line: block.startLine,
      },
    };
  });

  const filtered = query ? base.filter((entry) => entry.score > 0) : base;
  return filtered
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'Heading' ? -1 : 1;
      }
      return right.score - left.score;
    })
    .slice(0, query ? 24 : 18);
}

function renderSearchPreview(markdown) {
  if (!markdown) {
    return '';
  }

  try {
    const html = marked.parse(markdown, {
      gfm: true,
      breaks: false,
    });
    return typeof html === 'string' ? html : String(html);
  } catch (error) {
    console.error('Failed to render search preview.', { error, markdown });
    return `<p>${escapeHtml(markdown)}</p>`;
  }
}

function syncSelectedResult(buttons) {
  buttons.forEach((button, index) => {
    button.classList.toggle('is-selected', index === selectedResult);
  });
  buttons[selectedResult]?.scrollIntoView({ block: 'nearest' });
}

function clearSearchHighlights() {
  docRoot.querySelectorAll('.md-block.is-search-hit').forEach((block) => block.classList.remove('is-search-hit'));
}

function jumpToTarget(anchor) {
  const heading = anchor?.headingId ? document.getElementById(anchor.headingId) : null;
  const block = anchor?.blockId
    ? docRoot.querySelector(`.md-block[data-block-id="${CSS.escape(anchor.blockId)}"]`)
    : anchor?.line
      ? docRoot.querySelector(`.md-block[data-start-line="${CSS.escape(String(anchor.line))}"]`)
      : null;
  const target = heading || block;

  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const flashTarget = target.classList?.contains('md-block') ? target : target.closest('.md-block') || target;
  flashTarget.classList.add('is-flash');
  setTimeout(() => flashTarget.classList.remove('is-flash'), 1200);
}

function fuzzyScore(query, text) {
  if (!query) {
    return 1;
  }
  if (text.includes(query)) {
    return query.length * 10;
  }
  let score = 0;
  let cursor = 0;
  for (const char of query) {
    const index = text.indexOf(char, cursor);
    if (index === -1) {
      return 0;
    }
    score += index === cursor ? 4 : 1;
    cursor = index + 1;
  }
  return score;
}

function toRelativePath(value) {
  if (!value) {
    return null;
  }
  if (value.endsWith('.feedback.json')) {
    value = value.slice(0, -'.feedback.json'.length);
  }
  if (value.endsWith(`/${state.currentPath}`) || value.endsWith(`\\${state.currentPath}`)) {
    return state.currentPath;
  }
  if (value === state.currentPath) {
    return value;
  }
  if (value.includes('/')) {
    const parts = value.split('/');
    return parts.slice(parts.findIndex((part) => part === currentDoc.fileName)).join('/') || parts.at(-1);
  }
  return value;
}

function showToast(message) {
  statusToast.hidden = false;
  statusToast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    statusToast.hidden = true;
  }, 1800);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
