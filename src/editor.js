import { Editor } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { TextSelection } from '@tiptap/pm/state';
import { marked } from 'marked';
import { common, createLowlight } from 'lowlight';
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
const saveStatus = document.getElementById('saveStatus');
const saveEditButton = document.getElementById('saveEditButton');
const floatingToolbarRoot = document.getElementById('floatingToolbarRoot');
const composerRoot = document.getElementById('composerRoot');
const statusToast = document.getElementById('statusToast');
const html = document.documentElement;
const lowlight = createLowlight(common);

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
let pendingDecorateFrame = 0;
let dirty = false;
let saveInFlight = false;

applyStoredTheme();
init();

function init() {
  renderFromDoc(currentDoc);
  renderFeedback(feedbackState);
  bindEvents();
  syncSaveState();
  syncThemeWithDocument();
  hydrateFromHash();
  connectSocket();
}

function bindEvents() {
  themeToggle?.addEventListener('click', toggleTheme);
  searchTrigger?.addEventListener('click', openSearch);
  sidebarToggle?.addEventListener('click', () => layout.classList.toggle('sidebar-open'));
  sendFeedbackButton?.addEventListener('click', sendFeedback);
  saveEditButton?.addEventListener('click', async () => {
    await saveDocument();
  });

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
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      await saveDocument();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
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
      const container = copyButton.closest('.md-block, .code-block, pre');
      const code = container?.querySelector('pre code, code');
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
  const blocks = (doc.blocks || []).map((block) => ({
    ...block,
    previewHtml: renderSearchPreview(block.markdown),
  }));

  currentDoc = {
    ...doc,
    blocks,
    markdown: buildDocumentMarkdown(blocks, doc.lineCount),
  };
  pageTitle.textContent = currentDoc.title;
  document.title = currentDoc.title;
  renderFiles(state.fileTree || []);
  mountDocumentEditor(currentDoc.markdown);
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
  const editorRoot = getEditorRoot();
  if (!editorRoot) {
    renderToc([]);
    return;
  }

  editorRoot.querySelectorAll('.heading-reactions').forEach((node) => node.remove());
  const blocks = [...editorRoot.children].filter((node) => node.nodeType === Node.ELEMENT_NODE);
  const slugCounts = new Map();
  const liveToc = [];
  let currentSection = currentDoc.title;

  blocks.forEach((block, index) => {
    const matchedBlock = currentDoc.blocks[index];
    const kind = classifyBlock(block);

    [...block.classList]
      .filter((name) => name.startsWith('md-block--'))
      .forEach((name) => block.classList.remove(name));

    block.classList.add('md-block', `md-block--${kind}`);
    block.dataset.blockId = `block-${index + 1}`;
    block.dataset.blockType = kind;
    block.dataset.startLine = String(matchedBlock?.startLine ?? index + 1);
    block.dataset.endLine = String(matchedBlock?.endLine ?? matchedBlock?.startLine ?? index + 1);

    if (/^H[1-6]$/.test(block.tagName)) {
      const depth = Number(block.tagName.slice(1));
      const text = cleanNodeText(block);
      const headingId = uniqueSlug(text, slugCounts);
      currentSection = text || currentSection;
      block.id = headingId;
      block.dataset.headingId = headingId;
      block.dataset.headingDepth = String(depth);
      block.dataset.headingText = text;
      liveToc.push({ id: headingId, text, depth });

      if ((depth === 2 || depth === 3) && state.editable) {
        const reactions = document.createElement('div');
        reactions.className = 'heading-reactions';
        reactions.contentEditable = 'false';
        reactions.innerHTML = `
          <button type="button" data-feedback-type="approve" aria-label="Approve section" title="Approve section">&#128077;</button>
          <button type="button" data-feedback-type="reject" aria-label="Reject section" title="Reject section">&#128078;</button>
          <button type="button" data-feedback-type="comment" aria-label="Comment on section" title="Comment on section">&#128172;</button>
        `;
        block.appendChild(reactions);
      }
    } else {
      delete block.dataset.headingId;
      delete block.dataset.headingDepth;
      delete block.dataset.headingText;
    }

    if (kind === 'code' && !block.querySelector(':scope > .copy-code')) {
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'copy-code';
      copyButton.textContent = 'Copy';
      copyButton.contentEditable = 'false';
      copyButton.tabIndex = -1;
      block.appendChild(copyButton);
    }

    block.dataset.section = currentSection;
    block.dataset.searchText = cleanNodeText(block);
  });

  renderToc(liveToc);
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
  if (!confirmDiscardChanges()) {
    return false;
  }

  closeComposer();
  const scroll = window.scrollY;
  const response = await fetch(`/api/doc?path=${encodeURIComponent(relativePath)}&theme=${encodeURIComponent(currentTheme())}`);
  if (!response.ok) {
    showToast('Unable to load document');
    return false;
  }

  const doc = await response.json();
  renderFromDoc(doc);
  state.currentPath = doc.relativePath;
  await loadFeedback();

  if (pushHistory) {
    history.pushState({ path: relativePath, scroll }, '', `#file=${encodeURIComponent(relativePath)}`);
  }

  requestAnimationFrame(() => window.scrollTo({ top: 0 }));
  return true;
}

function connectSocket() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws`);

  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === 'file-changed') {
      if (isDirty()) {
        showToast('File changed on disk while you have unsaved edits');
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
      if (!isDirty() && changedRelative === state.currentPath) {
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
  if (isDirty()) {
    return;
  }

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

function mountDocumentEditor(markdown) {
  destroyEditor();
  closeComposer();
  docRoot.innerHTML = '';

  const host = document.createElement('div');
  host.className = 'editor-host';
  docRoot.appendChild(host);

  let editor;

  try {
    editor = createMarkdownEditor(host, markdown, 'Type / for commands, or start writing…');
  } catch (error) {
    console.error('Failed to initialize TipTap editor.', {
      error,
      path: currentDoc.relativePath,
      markdown,
    });
    showToast('Unable to start inline editor. Check console.');
    return;
  }

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
    editor,
    host,
    toolbar: null,
    slashMenu: null,
    slashState: null,
    slashIndex: 0,
  };

  dirty = false;
  syncSaveState();
  scheduleDecorateDocument();
}

function destroyEditor() {
  if (!activeEditor) {
    return;
  }

  cancelAnimationFrame(pendingDecorateFrame);
  pendingDecorateFrame = 0;
  closeFloatingToolbar();
  closeSlashMenu();
  activeEditor.editor?.destroy();
  activeEditor = null;
}

async function saveDocument() {
  if (!state.editable || !activeEditor || saveInFlight || !isDirty()) {
    return;
  }

  const markdownStorage = activeEditor.editor.storage.markdown;
  if (!markdownStorage?.getMarkdown) {
    console.error('Markdown serializer is unavailable on the active editor.', activeEditor);
    showToast('Unable to save: markdown serializer unavailable.');
    return;
  }

  const context = getSelectionContext();
  const markdown = normalizeSerializedMarkdown(markdownStorage.getMarkdown());
  const payload = {
    path: currentDoc.relativePath,
    startLine: 1,
    endLine: Number(currentDoc.lineCount),
    content: markdown,
    section: context.section || currentDoc.title,
    anchor: {
      blockId: context.block?.dataset.blockId || null,
      headingId: context.block?.dataset.headingId || null,
      line: Number(context.block?.dataset.startLine) || 1,
    },
  };

  saveInFlight = true;
  syncSaveState();

  try {
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

    dirty = false;
    currentDoc.markdown = markdown;
    await refreshCurrentDocument(true);
    await loadFeedback();
    showToast('Saved');
  } finally {
    saveInFlight = false;
    syncSaveState();
  }
}

function normalizeSerializedMarkdown(markdown) {
  return markdown.replace(/\s+$/, '');
}

function getEditorRoot() {
  return activeEditor?.editor?.view?.dom || null;
}

function getEditorMarkdown() {
  const markdownStorage = activeEditor?.editor?.storage?.markdown;
  return markdownStorage?.getMarkdown ? normalizeSerializedMarkdown(markdownStorage.getMarkdown()) : currentDoc.markdown;
}

function isDirty() {
  return dirty;
}

function syncSaveState() {
  const showSaveControls = Boolean(state.editable && (dirty || saveInFlight));

  if (saveStatus) {
    saveStatus.hidden = !showSaveControls;
    saveStatus.textContent = saveInFlight ? 'Saving…' : 'Unsaved changes';
  }

  if (saveEditButton) {
    saveEditButton.hidden = !showSaveControls;
    saveEditButton.disabled = saveInFlight || !dirty;
  }
}

function syncDirtyState() {
  if (!state.editable || !activeEditor) {
    dirty = false;
    syncSaveState();
    return;
  }

  const nextDirty = getEditorMarkdown() !== currentDoc.markdown;
  if (nextDirty !== dirty) {
    dirty = nextDirty;
    syncSaveState();
  }
}

function confirmDiscardChanges() {
  return !isDirty() || window.confirm('You have unsaved changes. Discard them and continue?');
}

function scheduleDecorateDocument() {
  cancelAnimationFrame(pendingDecorateFrame);
  pendingDecorateFrame = requestAnimationFrame(() => {
    pendingDecorateFrame = 0;
    decorateDocument();
  });
}

function classifyBlock(block) {
  if (/^H[1-6]$/.test(block.tagName)) {
    return 'heading';
  }

  if (block.tagName === 'PRE') {
    return 'code';
  }

  if (block.tagName === 'BLOCKQUOTE') {
    return 'blockquote';
  }

  if (block.tagName === 'UL' || block.tagName === 'OL') {
    return 'list';
  }

  if (block.tagName === 'HR') {
    return 'rule';
  }

  if (block.tagName === 'TABLE' || block.classList.contains('tableWrapper') || block.querySelector(':scope > table')) {
    return 'table';
  }

  return 'paragraph';
}

function cleanNodeText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll?.('.heading-reactions, .copy-code').forEach((entry) => entry.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function getSelectionContext() {
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode;
  const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
  const block = anchorElement?.closest('.md-block') || getEditorRoot()?.querySelector('.md-block');
  return {
    block,
    section: block?.dataset.section || currentDoc.title,
  };
}

function syncFloatingToolbar() {
  if (!activeEditor || !state.editable) {
    closeFloatingToolbar();
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
        const context = getSelectionContext();
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
              section: context.section,
              selectedText,
              comment,
              line: Number(context.block?.dataset.startLine) || 1,
              anchor: {
                blockId: context.block?.dataset.blockId || null,
                headingId: context.block?.dataset.headingId || null,
                line: Number(context.block?.dataset.startLine) || 1,
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
  if (!activeEditor || !state.editable) {
    closeSlashMenu();
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

  if (!isDirty()) {
    refreshCurrentDocument(true);
  }
}

function createMarkdownEditor(element, content, placeholder) {
  return new Editor({
    element,
    content,
    editable: state.editable,
    extensions: [
      StarterKit.configure({
        link: false,
        codeBlock: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
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
        placeholder,
      }),
      Markdown.configure({
        html: true,
        linkify: true,
        transformPastedText: true,
      }),
    ],
    autofocus: false,
    editorProps: {
      attributes: {
        class: 'mdview-editor',
      },
      handleDOMEvents: {
        dblclick: (view, event) => {
          if (!state.editable) {
            return false;
          }

          const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!position) {
            return false;
          }

          const selection = TextSelection.near(view.state.doc.resolve(position.pos));
          view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
          view.focus();
          event.preventDefault();
          return true;
        },
      },
    },
    onCreate: () => {
      scheduleDecorateDocument();
      syncDirtyState();
    },
    onSelectionUpdate: () => {
      syncFloatingToolbar();
      syncSlashMenu();
    },
    onUpdate: () => {
      syncDirtyState();
      syncFloatingToolbar();
      syncSlashMenu();
      scheduleDecorateDocument();
    },
  });
}

function buildDocumentMarkdown(blocks, lineCount) {
  const lines = Array.from({ length: Math.max(1, Number(lineCount) || 0) }, () => '');
  for (const block of blocks) {
    const blockLines = String(block.markdown || '').split('\n');
    const offset = Math.max(0, Number(block.startLine) - 1);
    blockLines.forEach((line, index) => {
      lines[offset + index] = line;
    });
  }
  return lines.join('\n');
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
  const base = collectDocumentBlocks().map((block) => {
    const kind = block.headingId ? 'Heading' : 'Content';
    const score = query ? fuzzyScore(query, block.searchText.toLowerCase()) : 1;
    return {
      score,
      kind,
      section: block.section,
      startLine: block.startLine,
      previewHtml: block.previewHtml,
      anchor: {
        blockId: block.blockId,
        headingId: block.headingId,
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

function collectDocumentBlocks() {
  const editorRoot = getEditorRoot();
  if (!editorRoot) {
    return [];
  }

  return [...editorRoot.querySelectorAll(':scope > .md-block')].map((block) => {
    const preview = block.cloneNode(true);
    preview.querySelectorAll('.heading-reactions, .copy-code').forEach((node) => node.remove());

    return {
      blockId: block.dataset.blockId,
      headingId: block.dataset.headingId || null,
      section: block.dataset.section || currentDoc.title,
      startLine: Number(block.dataset.startLine) || 1,
      searchText: block.dataset.searchText || cleanNodeText(block),
      previewHtml: preview.outerHTML,
    };
  });
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
