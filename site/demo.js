import { Editor } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import { createLowlight } from 'lowlight';
import { Markdown } from 'tiptap-markdown';

const html = document.documentElement;
const docRoot = document.getElementById('docRoot');
const feedbackList = document.getElementById('feedbackList');
const feedbackCount = document.getElementById('feedbackCount');
const floatingToolbarRoot = document.getElementById('floatingToolbarRoot');
const composerRoot = document.getElementById('composerRoot');
const statusToast = document.getElementById('statusToast');
const installCommand = document.getElementById('installCommand');
const lowlight = createLowlight();

lowlight.register({
  bash,
  javascript,
  json,
  markdown,
  typescript,
  xml,
});

lowlight.registerAlias({
  html: 'xml',
  js: 'javascript',
  md: 'markdown',
  sh: 'bash',
  ts: 'typescript',
});

const SLASH_COMMANDS = [
  { id: 'heading-2', label: 'Heading 2', detail: 'Large section heading', run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'heading-3', label: 'Heading 3', detail: 'Sub-section heading', run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet-list', label: 'Bullet List', detail: 'Create a bulleted list', run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'task-list', label: 'Task List', detail: 'Checklist with completion states', run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'code-block', label: 'Code Block', detail: 'Monospace fenced code block', run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'blockquote', label: 'Blockquote', detail: 'Highlight a reviewable note', run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: 'table', label: 'Table', detail: 'Insert a 3x3 table', run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'divider', label: 'Divider', detail: 'Horizontal rule', run: (editor) => editor.chain().focus().setHorizontalRule().run() },
];

let editor = null;
let toolbar = null;
let composer = null;
let slashMenu = null;
let headingActions = null;
let activeHeadingBlock = null;
let headingHideTimer = null;
let slashState = null;
let slashIndex = 0;
let pendingDecorateFrame = 0;
let toastTimer = null;
let feedback = [];
let initialMarkdown = '';

init();

async function init() {
  applyStoredTheme();
  bindChrome();
  initRevealObserver();

  initialMarkdown = await loadSampleMarkdown();
  mountEditor(initialMarkdown);
  renderFeedback();
}

function bindChrome() {
  document.querySelectorAll('[data-theme-toggle="true"]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = currentTheme() === 'light' ? 'dark' : 'light';
      html.dataset.theme = next;
      localStorage.setItem('mdsync-site-theme', next);
      syncThemeButtons();
    });
  });

  document.querySelector('[data-copy-command="true"]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(installCommand.textContent.trim());
      showToast('Install command copied');
    } catch (error) {
      console.error('Unable to copy install command.', error);
      showToast('Clipboard unavailable');
    }
  });

  document.querySelector('[data-reset-demo="true"]')?.addEventListener('click', () => {
    feedback = [];
    renderFeedback();
    mountEditor(initialMarkdown);
    showToast('Demo reset');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeComposer();
      closeFloatingToolbar();
      closeSlashMenu();
      hideHeadingActions();
    }
  });

  window.addEventListener('resize', syncHeadingActionsPosition);
  window.addEventListener('scroll', syncHeadingActionsPosition, true);
  syncThemeButtons();
}

async function loadSampleMarkdown() {
  try {
    const response = await fetch('./sample.md');
    if (!response.ok) {
      throw new Error(`Unexpected status ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    console.error('Falling back to inline sample markdown.', error);
    return '# mdsync\n\n## Demo\n\nThis fallback sample loaded because `sample.md` was unavailable.';
  }
}

function mountEditor(content) {
  destroyEditor();
  docRoot.innerHTML = '';

  editor = new Editor({
    element: docRoot,
    content,
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
        placeholder: 'Start editing this markdown document...',
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
        class: 'mdsync-editor',
      },
      handleDOMEvents: {
        dblclick: (view, event) => {
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
      handleKeyDown: (_, event) => handleSlashNavigation(event),
    },
    onCreate: () => {
      scheduleDecorateDocument();
    },
    onSelectionUpdate: () => {
      syncFloatingToolbar();
      syncSlashMenu();
    },
    onUpdate: () => {
      syncFloatingToolbar();
      syncSlashMenu();
      scheduleDecorateDocument();
    },
  });

  docRoot.addEventListener('click', handleDocClick);
  docRoot.addEventListener('mousemove', handleDocHover);
  docRoot.addEventListener('mouseleave', scheduleHideHeadingActions);
  scheduleDecorateDocument();
}

function destroyEditor() {
  closeFloatingToolbar();
  closeComposer();
  closeSlashMenu();

  if (!editor) {
    return;
  }

  docRoot.removeEventListener('click', handleDocClick);
  docRoot.removeEventListener('mousemove', handleDocHover);
  docRoot.removeEventListener('mouseleave', scheduleHideHeadingActions);
  editor.destroy();
  editor = null;
}

function handleDocClick(event) {
  const copyButton = event.target.closest('.copy-code');
  if (copyButton) {
    copyCode(copyButton);
    return;
  }

  const reaction = event.target.closest('[data-feedback-type]');
  if (reaction) {
    event.preventDefault();
    const block = reaction.closest('.md-block');
    handleHeadingReaction(block, reaction.dataset.feedbackType, reaction);
  }
}

function handleDocHover(event) {
  const heading = event.target.closest('.ProseMirror h2, .ProseMirror h3');
  if (!heading) {
    scheduleHideHeadingActions();
    return;
  }

  const block = heading.closest('.md-block') || heading;
  showHeadingActions(block);
}

async function copyCode(button) {
  const container = button.closest('.md-block, pre');
  const code = container?.querySelector('pre code, code');
  if (!code) {
    return;
  }

  try {
    await navigator.clipboard.writeText(code.innerText);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1200);
  } catch (error) {
    console.error('Unable to copy code block.', error);
    showToast('Clipboard unavailable');
  }
}

function handleSlashNavigation(event) {
  if (!slashState) {
    return false;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    slashIndex = Math.min(slashIndex + 1, slashState.items.length - 1);
    renderSlashMenu();
    return true;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    slashIndex = Math.max(slashIndex - 1, 0);
    renderSlashMenu();
    return true;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    applySlashCommand(slashState.items[slashIndex]);
    return true;
  }

  if (event.key === 'Escape') {
    closeSlashMenu();
    return true;
  }

  return false;
}

function scheduleDecorateDocument() {
  cancelAnimationFrame(pendingDecorateFrame);
  pendingDecorateFrame = requestAnimationFrame(() => {
    pendingDecorateFrame = 0;
    decorateDocument();
  });
}

function decorateDocument() {
  const editorRoot = getEditorRoot();
  if (!editorRoot) {
    return;
  }

  editorRoot.querySelectorAll('.heading-reactions').forEach((node) => node.remove());
  const blocks = [...editorRoot.children].filter((node) => node.nodeType === Node.ELEMENT_NODE);
  const slugCounts = new Map();
  let currentSection = 'Untitled section';

  blocks.forEach((block, index) => {
    const kind = classifyBlock(block);
    const nextClassName = [...block.classList]
      .filter((name) => !name.startsWith('md-block--') && name !== 'md-block')
      .join(' ');

    block.className = `${nextClassName} md-block md-block--${kind}`.trim();
    block.dataset.blockId = `block-${index + 1}`;
    block.dataset.blockType = kind;

    if (/^H[1-6]$/.test(block.tagName)) {
      const depth = Number(block.tagName.slice(1));
      const text = cleanNodeText(block);
      const headingId = uniqueSlug(text, slugCounts);
      currentSection = text || currentSection;
      block.id = headingId;
      block.dataset.headingId = headingId;
      block.dataset.headingDepth = String(depth);
      block.dataset.headingText = text;
    } else {
      delete block.dataset.headingId;
      delete block.dataset.headingDepth;
      delete block.dataset.headingText;
    }

    block.dataset.section = currentSection;
  });

  syncHeadingActionsPosition();
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

function syncFloatingToolbar() {
  if (!editor) {
    closeFloatingToolbar();
    return;
  }

  const { selection } = editor.state;
  if (selection.empty) {
    closeFloatingToolbar();
    return;
  }

  if (!toolbar) {
    toolbar = document.createElement('div');
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
          onSubmit: (comment) => {
            addFeedback({
              type: 'comment',
              section: context.section,
              selectedText,
              comment,
              anchor: {
                blockId: context.block?.dataset.blockId || null,
                headingId: context.block?.dataset.headingId || null,
              },
            });
          },
        });
      }

      syncFloatingToolbar();
    });
    floatingToolbarRoot.appendChild(toolbar);
  }

  const from = editor.view.coordsAtPos(selection.from);
  const to = editor.view.coordsAtPos(selection.to);
  const left = Math.max(12, Math.min((from.left + to.right) / 2 - toolbar.offsetWidth / 2, window.innerWidth - toolbar.offsetWidth - 12));
  const top = Math.max(12, from.top - 58);

  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  toolbar.querySelector('[data-command="bold"]').dataset.active = String(editor.isActive('bold'));
  toolbar.querySelector('[data-command="italic"]').dataset.active = String(editor.isActive('italic'));
  toolbar.querySelector('[data-command="link"]').dataset.active = String(editor.isActive('link'));
}

function closeFloatingToolbar() {
  if (!toolbar) {
    return;
  }

  toolbar.remove();
  toolbar = null;
}

function getSelectionContext() {
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode;
  const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
  const block = anchorElement?.closest('.md-block') || getEditorRoot()?.querySelector('.md-block');

  return {
    block,
    section: block?.dataset.section || 'Untitled section',
  };
}

function syncSlashMenu() {
  if (!editor) {
    closeSlashMenu();
    return;
  }

  const nextSlashState = getSlashState(editor);
  if (!nextSlashState) {
    closeSlashMenu();
    return;
  }

  slashState = nextSlashState;
  if (!slashMenu) {
    slashMenu = document.createElement('div');
    slashMenu.className = 'slash-menu';
    document.body.appendChild(slashMenu);
  }

  const coords = editor.view.coordsAtPos(editor.state.selection.from);
  slashMenu.style.left = `${Math.max(12, Math.min(coords.left, window.innerWidth - 292))}px`;
  slashMenu.style.top = `${coords.bottom + 10}px`;
  renderSlashMenu();
}

function getSlashState(activeEditor) {
  const { selection } = activeEditor.state;
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
  slashIndex = Math.min(slashIndex, items.length - 1);
  return { from, to: selection.from, items };
}

function renderSlashMenu() {
  if (!slashMenu || !slashState) {
    return;
  }

  slashMenu.innerHTML = slashState.items.map((item, index) => `
    <button type="button" class="${index === slashIndex ? 'is-active' : ''}" data-slash-command="${escapeAttribute(item.id)}">
      ${escapeHtml(item.label)}
      <small>${escapeHtml(item.detail)}</small>
    </button>
  `).join('');

  slashMenu.querySelectorAll('[data-slash-command]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = slashState.items.find((entry) => entry.id === button.dataset.slashCommand);
      applySlashCommand(item);
    });
  });
}

function applySlashCommand(item) {
  if (!item || !slashState || !editor) {
    return;
  }

  editor.chain().focus().deleteRange({ from: slashState.from, to: slashState.to }).run();
  item.run(editor);
  closeSlashMenu();
  editor.commands.focus();
}

function closeSlashMenu() {
  slashState = null;
  slashIndex = 0;
  if (!slashMenu) {
    return;
  }

  slashMenu.remove();
  slashMenu = null;
}

function handleHeadingReaction(block, type, trigger) {
  if (!block) {
    return;
  }

  const section = block.dataset.headingText || block.dataset.section || cleanNodeText(block) || 'Untitled section';
  const anchor = {
    blockId: block.dataset.blockId || null,
    headingId: block.dataset.headingId || null,
  };

  if (type === 'approve') {
    addFeedback({ type, section, anchor });
    return;
  }

  const rect = trigger.getBoundingClientRect();
  openComposer({
    x: rect.left,
    y: rect.bottom + 12,
    title: type === 'reject' ? 'Why reject this section?' : 'Comment on section',
    meta: section,
    placeholder: type === 'reject' ? 'Describe what needs to change' : 'Add a targeted note',
    onSubmit: (comment) => {
      addFeedback({
        type,
        section,
        comment,
        anchor,
      });
    },
  });
}

function ensureHeadingActions() {
  if (headingActions) {
    return headingActions;
  }

  headingActions = document.createElement('div');
  headingActions.className = 'heading-reactions';
  headingActions.hidden = true;
  headingActions.innerHTML = `
    <button type="button" data-feedback-type="approve" aria-label="Approve section" title="Approve section">&#128077;</button>
    <button type="button" data-feedback-type="reject" aria-label="Reject section" title="Reject section">&#128078;</button>
    <button type="button" data-feedback-type="comment" aria-label="Comment on section" title="Comment on section">&#128172;</button>
  `;

  headingActions.addEventListener('mouseenter', () => {
    clearTimeout(headingHideTimer);
  });

  headingActions.addEventListener('mouseleave', scheduleHideHeadingActions);
  headingActions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feedback-type]');
    if (!button || !activeHeadingBlock) {
      return;
    }

    event.preventDefault();
    handleHeadingReaction(activeHeadingBlock, button.dataset.feedbackType, button);
  });

  document.body.appendChild(headingActions);
  return headingActions;
}

function showHeadingActions(block) {
  if (!block || block.dataset.headingDepth === '1') {
    scheduleHideHeadingActions();
    return;
  }

  clearTimeout(headingHideTimer);
  activeHeadingBlock = block;
  const actions = ensureHeadingActions();
  actions.hidden = false;
  syncHeadingActionsPosition();
}

function syncHeadingActionsPosition() {
  if (!headingActions || headingActions.hidden || !activeHeadingBlock) {
    return;
  }

  const rect = activeHeadingBlock.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    hideHeadingActions();
    return;
  }

  const left = Math.max(12, Math.min(rect.right - headingActions.offsetWidth - 10, window.innerWidth - headingActions.offsetWidth - 12));
  const top = Math.max(20, rect.top + rect.height / 2);

  headingActions.style.left = `${left}px`;
  headingActions.style.top = `${top}px`;
}

function scheduleHideHeadingActions() {
  clearTimeout(headingHideTimer);
  headingHideTimer = setTimeout(() => {
    hideHeadingActions();
  }, 120);
}

function hideHeadingActions() {
  clearTimeout(headingHideTimer);
  activeHeadingBlock = null;
  if (headingActions) {
    headingActions.hidden = true;
  }
}

function openComposer({ x, y, title, meta, placeholder, onSubmit }) {
  closeComposer();

  composer = document.createElement('div');
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

  composer.addEventListener('click', (event) => {
    if (event.target.dataset.composerCancel === 'true') {
      closeComposer();
      return;
    }

    if (event.target.dataset.composerSave === 'true') {
      onSubmit(textarea.value.trim());
      closeComposer();
    }
  });
}

function closeComposer() {
  if (!composer) {
    return;
  }

  composer.remove();
  composer = null;
}

function addFeedback(entry) {
  feedback.unshift({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry,
  });
  renderFeedback();
  showToast('Feedback captured');
}

function renderFeedback() {
  feedbackCount.textContent = String(feedback.length);

  if (feedback.length === 0) {
    feedbackList.innerHTML = '<div class="feedback-empty">Select text or use the heading actions to add a note.</div>';
    return;
  }

  feedbackList.innerHTML = feedback.map((item) => `
    <article class="feedback-item" data-feedback-id="${escapeAttribute(item.id)}">
      <div class="feedback-item__header">
        <div class="feedback-item__badge">${escapeHtml(changeLabel(item.type))}</div>
        <button class="feedback-item__delete" type="button" data-delete-feedback-id="${escapeAttribute(item.id)}">x</button>
      </div>
      <div class="feedback-item__section">${escapeHtml(item.section || 'Untitled section')}</div>
      <div class="feedback-item__body">${feedbackBody(item)}</div>
      <button class="feedback-item__jump" type="button" data-jump-feedback-id="${escapeAttribute(item.id)}">Jump to location</button>
    </article>
  `).join('');

  feedbackList.querySelectorAll('[data-delete-feedback-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      feedback = feedback.filter((item) => item.id !== button.dataset.deleteFeedbackId);
      renderFeedback();
    });
  });

  feedbackList.querySelectorAll('[data-jump-feedback-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = feedback.find((entry) => entry.id === button.dataset.jumpFeedbackId);
      if (item) {
        jumpToTarget(item.anchor);
      }
    });
  });
}

function changeLabel(type) {
  switch (type) {
    case 'approve':
      return 'Approve';
    case 'reject':
      return 'Reject';
    default:
      return 'Comment';
  }
}

function feedbackBody(item) {
  const pieces = [];
  if (item.selectedText) {
    pieces.push(`<strong>${escapeHtml(item.selectedText)}</strong>`);
  }
  if (item.comment) {
    pieces.push(escapeHtml(item.comment));
  }
  if (pieces.length === 0 && item.type === 'approve') {
    pieces.push('Section approved with no additional changes requested.');
  }
  return pieces.join('<br />');
}

function jumpToTarget(anchor) {
  if (!anchor) {
    return;
  }

  const heading = anchor.headingId ? document.getElementById(anchor.headingId) : null;
  const block = anchor.blockId
    ? docRoot.querySelector(`.md-block[data-block-id="${CSS.escape(anchor.blockId)}"]`)
    : null;
  const target = heading || block;

  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const flashTarget = target.classList?.contains('md-block') ? target : target.closest('.md-block') || target;
  flashTarget.classList.add('is-flash');
  setTimeout(() => flashTarget.classList.remove('is-flash'), 1200);
}

function applyStoredTheme() {
  const savedTheme = localStorage.getItem('mdsync-site-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    html.dataset.theme = savedTheme;
  }
}

function syncThemeButtons() {
  const label = currentTheme() === 'light' ? 'Dark mode' : 'Light mode';
  document.querySelectorAll('[data-theme-toggle="true"]').forEach((button) => {
    button.textContent = label;
  });
}

function currentTheme() {
  return html.dataset.theme === 'light' ? 'light' : 'dark';
}

function initRevealObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18 });

  document.querySelectorAll('.reveal').forEach((node) => {
    if (!node.classList.contains('is-visible')) {
      observer.observe(node);
    }
  });
}

function getEditorRoot() {
  return editor?.view?.dom || null;
}

function uniqueSlug(text, counts) {
  const base = slugify(text) || 'section';
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
