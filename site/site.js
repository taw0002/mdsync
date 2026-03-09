const html = document.documentElement;
const statusToast = document.getElementById('statusToast');

function getTheme() {
  return html.dataset.theme === 'light' ? 'light' : 'dark';
}

function updateThemeButtons() {
  const label = getTheme() === 'light' ? 'Dark mode' : 'Light mode';
  document.querySelectorAll('[data-theme-toggle="true"]').forEach((button) => {
    button.textContent = label;
  });
}

function showToast(message) {
  if (!statusToast) {
    return;
  }

  statusToast.hidden = false;
  statusToast.textContent = message;
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    statusToast.hidden = true;
  }, 1800);
}

function setupThemeToggle() {
  const savedTheme = localStorage.getItem('mdsync-site-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    html.dataset.theme = savedTheme;
  }

  updateThemeButtons();

  document.querySelectorAll('[data-theme-toggle="true"]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextTheme = getTheme() === 'light' ? 'dark' : 'light';
      html.dataset.theme = nextTheme;
      localStorage.setItem('mdsync-site-theme', nextTheme);
      updateThemeButtons();
    });
  });
}

function setupCopyButtons() {
  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.querySelector(button.dataset.copyTarget);
      const text = target?.textContent?.trim();

      if (!text) {
        showToast('Nothing to copy');
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        showToast('Copied');
      } catch (error) {
        console.error('Clipboard write failed.', error);
        showToast('Clipboard unavailable');
      }
    });
  });
}

function setupReveal() {
  const nodes = document.querySelectorAll('.reveal');
  if (nodes.length === 0) {
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18 });

  nodes.forEach((node) => {
    if (!node.classList.contains('is-visible')) {
      observer.observe(node);
    }
  });
}

setupThemeToggle();
setupCopyButtons();
setupReveal();
