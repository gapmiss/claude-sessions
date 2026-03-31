/**
 * Standalone JavaScript for exported HTML files.
 * Handles collapsibles, copy buttons, show-more, image modal, content filters.
 * Returned as a string to be embedded in a <script> tag.
 */

export function getStandaloneScript(): string {
	return `(function() {
  'use strict';

  /* ── Collapsible toggle (turns, tools, tool groups, thinking, sub-agents, summary, slash commands) ── */
  /*
   * The live view uses CSS class toggling — NOT display manipulation:
   *   - Turn: "collapsed" class on .claude-sessions-turn
   *   - Everything else: "open" class on the parent container
   * The CSS handles show/hide via these classes.
   */
  function toggleCollapsible(header) {
    var expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));

    /* Turn header: toggle "collapsed" class on turn element */
    var turn = header.closest('.claude-sessions-turn');
    if (turn && header.classList.contains('claude-sessions-turn-header')) {
      turn.classList.toggle('collapsed', expanded); /* expanded=true means collapse */
      return;
    }

    /* All other collapsibles: header is always a direct child of its container.
     * Toggle "open" class on the parent element. */
    var parent = header.parentElement;
    if (parent) {
      parent.classList.toggle('open', !expanded);
    }
  }

  /* ── Show more / show less ── */
  function toggleShowMore(btn) {
    var wrap = btn.closest('.claude-sessions-collapsible-wrap');
    if (!wrap) return;
    var collapsed = wrap.classList.toggle('is-collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
    var lineCount = btn.getAttribute('data-line-count') || '';
    btn.textContent = collapsed ? 'Show more (' + lineCount + ' lines)' : 'Show less';
  }

  /* ── Copy to clipboard ── */
  function copyText(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      /* Fallback for file:// protocol */
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    /* Visual feedback */
    if (btn) {
      var orig = btn.innerHTML;
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      setTimeout(function() { btn.innerHTML = orig; }, 1500);
    }
  }

  /* ── Image modal ── */
  var modalOverlay = null;

  function openImageModal(src, mime) {
    closeImageModal();
    modalOverlay = document.createElement('div');
    modalOverlay.className = 'claude-sessions-image-modal-overlay';
    modalOverlay.addEventListener('click', function(e) {
      if (e.target === modalOverlay) closeImageModal();
    });

    var container = document.createElement('div');
    container.className = 'claude-sessions-image-modal-container';

    var img = document.createElement('img');
    img.src = src;
    img.style.maxWidth = '100%';
    img.style.maxHeight = 'calc(85vh - 60px)';
    container.appendChild(img);

    var toolbar = document.createElement('div');
    toolbar.className = 'claude-sessions-image-modal-toolbar';

    var dlBtn = document.createElement('a');
    dlBtn.href = src;
    dlBtn.download = 'image.' + (mime || 'png').split('/').pop();
    dlBtn.textContent = 'Download';
    dlBtn.className = 'claude-sessions-image-modal-btn';
    toolbar.appendChild(dlBtn);

    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'claude-sessions-image-modal-btn';
    closeBtn.addEventListener('click', closeImageModal);
    toolbar.appendChild(closeBtn);

    container.appendChild(toolbar);
    modalOverlay.appendChild(container);
    document.body.appendChild(modalOverlay);
  }

  function closeImageModal() {
    if (modalOverlay) {
      modalOverlay.remove();
      modalOverlay = null;
    }
  }

  /* ── Mermaid diagram modal ── */
  function openMermaidModal(svgEl) {
    closeImageModal();
    modalOverlay = document.createElement('div');
    modalOverlay.className = 'claude-sessions-image-modal-overlay';
    modalOverlay.addEventListener('click', function(e) {
      if (e.target === modalOverlay) closeImageModal();
    });

    var container = document.createElement('div');
    container.className = 'claude-sessions-image-modal-container';
    container.style.width = '90vw';
    container.style.maxHeight = '90vh';

    /* Clone SVG with ID remapping to avoid style collisions */
    var scrollWrap = document.createElement('div');
    scrollWrap.style.overflow = 'auto';
    scrollWrap.style.flex = '1';
    scrollWrap.style.minHeight = '0';
    scrollWrap.style.width = '100%';
    scrollWrap.style.padding = '16px';
    scrollWrap.style.boxSizing = 'border-box';
    scrollWrap.style.background = 'var(--background-primary, #1e1e1e)';
    scrollWrap.style.borderRadius = 'var(--radius-m, 8px)';
    var serializer = new XMLSerializer();
    var svgString = serializer.serializeToString(svgEl);
    var origId = svgEl.id;
    if (origId) {
      svgString = svgString.split(origId).join('mermaid-preview-' + Date.now());
    }
    var parser = new DOMParser();
    var doc = parser.parseFromString(svgString, 'image/svg+xml');
    var svgNode = document.importNode(doc.documentElement, true);
    svgNode.style.removeProperty('max-width');
    svgNode.removeAttribute('width');
    svgNode.removeAttribute('height');
    svgNode.style.width = '100%';
    svgNode.style.height = 'auto';
    scrollWrap.appendChild(svgNode);
    container.appendChild(scrollWrap);

    var toolbar = document.createElement('div');
    toolbar.className = 'claude-sessions-image-modal-toolbar';

    var dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download SVG';
    dlBtn.className = 'claude-sessions-image-modal-btn';
    dlBtn.addEventListener('click', function() {
      var raw = serializer.serializeToString(svgEl);
      var blob = new Blob([raw], { type: 'image/svg+xml' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'diagram.svg';
      a.click();
      URL.revokeObjectURL(url);
    });
    toolbar.appendChild(dlBtn);

    var cpBtn = document.createElement('button');
    cpBtn.textContent = 'Copy SVG';
    cpBtn.className = 'claude-sessions-image-modal-btn';
    cpBtn.addEventListener('click', function() {
      var raw = serializer.serializeToString(svgEl);
      copyText(raw, cpBtn);
    });
    toolbar.appendChild(cpBtn);

    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'claude-sessions-image-modal-btn';
    closeBtn.addEventListener('click', closeImageModal);
    toolbar.appendChild(closeBtn);

    container.appendChild(toolbar);
    modalOverlay.appendChild(container);
    document.body.appendChild(modalOverlay);
  }

  /* ── Content filter menu ── */
  function buildFilterMenu() {
    var btn = document.getElementById('as-filter-btn');
    if (!btn) return;

    var menu = document.getElementById('as-filter-menu');
    if (menu) { menu.remove(); return; }

    menu = document.createElement('div');
    menu.id = 'as-filter-menu';
    menu.className = 'claude-sessions-filter-menu';

    var filters = [
      { key: 'user', label: 'User', parent: true },
      { key: 'userText', label: 'Text', parent: false, parentKey: 'user' },
      { key: 'userImages', label: 'Images', parent: false, parentKey: 'user' },
      { key: 'assistant', label: 'Assistant', parent: true },
      { key: 'assistantText', label: 'Text', parent: false, parentKey: 'assistant' },
      { key: 'thinking', label: 'Thinking', parent: false, parentKey: 'assistant' },
      { key: 'toolCalls', label: 'Tool calls', parent: false, parentKey: 'assistant' },
      { key: 'toolResults', label: 'Tool results', parent: false, parentKey: 'assistant' },
    ];

    var state = JSON.parse(document.getElementById('as-export-root').getAttribute('data-filters') || '{}');

    filters.forEach(function(f) {
      var row = document.createElement('label');
      row.className = 'claude-sessions-filter-row' + (f.parent ? ' parent' : ' child');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state[f.key] !== false;
      cb.addEventListener('change', function() {
        state[f.key] = cb.checked;
        document.getElementById('as-export-root').setAttribute('data-filters', JSON.stringify(state));
        applyFilters(state);
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + f.label));
      menu.appendChild(row);
    });

    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(menu);

    /* Close on outside click */
    setTimeout(function() {
      document.addEventListener('click', function handler(e) {
        if (!menu.contains(e.target) && e.target !== btn) {
          menu.remove();
          document.removeEventListener('click', handler);
        }
      });
    }, 0);
  }

  function applyFilters(state) {
    var root = document.getElementById('as-export-root');
    if (!root) return;
    var FC = 'claude-sessions-filtered';

    function toggleFiltered(el, hidden) {
      if (hidden) el.classList.add(FC); else el.classList.remove(FC);
    }

    /* User role sections */
    root.querySelectorAll('.claude-sessions-role-user').forEach(function(el) {
      toggleFiltered(el, state.user === false);
    });
    if (state.user !== false) {
      root.querySelectorAll('.claude-sessions-user-text').forEach(function(el) {
        var wrapper = el.closest('.claude-sessions-block-wrapper');
        if (wrapper) toggleFiltered(wrapper, state.userText === false);
      });
      root.querySelectorAll('.claude-sessions-slash-command-block').forEach(function(el) {
        var wrapper = el.closest('.claude-sessions-block-wrapper');
        if (wrapper) toggleFiltered(wrapper, state.userText === false);
      });
      root.querySelectorAll('.claude-sessions-image-thumbnail').forEach(function(el) {
        var wrapper = el.closest('.claude-sessions-block-wrapper');
        if (wrapper) toggleFiltered(wrapper, state.userImages === false);
      });
    }

    /* Assistant role sections */
    root.querySelectorAll('.claude-sessions-role-assistant').forEach(function(el) {
      toggleFiltered(el, state.assistant === false);
    });
    if (state.assistant !== false) {
      root.querySelectorAll('.claude-sessions-assistant-text').forEach(function(el) {
        var wrapper = el.closest('.claude-sessions-block-wrapper');
        if (wrapper) toggleFiltered(wrapper, state.assistantText === false);
      });
      root.querySelectorAll('.claude-sessions-thinking-block').forEach(function(el) {
        var wrapper = el.closest('.claude-sessions-block-wrapper');
        if (wrapper) toggleFiltered(wrapper, state.thinking === false);
      });
      root.querySelectorAll('.claude-sessions-tool-block, .claude-sessions-tool-group').forEach(function(el) {
        var wrapper = el.closest('.claude-sessions-block-wrapper');
        if (wrapper) toggleFiltered(wrapper, state.toolCalls === false);
      });
      root.querySelectorAll('.claude-sessions-tool-result').forEach(function(el) {
        toggleFiltered(el, state.toolResults === false);
      });
    }
  }

  /* ── Event delegation ── */
  document.addEventListener('click', function(e) {
    var target = e.target;

    /* Mermaid diagram containers */
    var mermaidContainer = target.closest('.claude-sessions-mermaid-container');
    if (mermaidContainer) {
      var svg = mermaidContainer.querySelector('svg');
      if (svg) openMermaidModal(svg);
      return;
    }

    /* Copy buttons — check before collapsibles so copy buttons inside headers work */
    var copyBtn = target.closest('.claude-sessions-copy-btn, .claude-sessions-text-copy, .claude-sessions-summary-copy, .copy-code-button');
    if (copyBtn) {
      e.preventDefault();
      var text = copyBtn.getAttribute('data-copy-text');
      if (!text) {
        /* Code block copy — find the <code> sibling */
        var pre = copyBtn.closest('pre');
        if (pre) {
          var code = pre.querySelector('code');
          text = code ? code.textContent : pre.textContent;
        }
      }
      if (text) copyText(text, copyBtn);
      return;
    }

    /* Walk up to find interactive element */
    var el = target.closest('[role="button"][aria-expanded]');
    if (el && document.getElementById('as-export-root')?.contains(el)) {
      toggleCollapsible(el);
      return;
    }

    /* Show more button */
    var showBtn = target.closest('.claude-sessions-collapsible-toggle');
    if (showBtn) {
      e.preventDefault();
      toggleShowMore(showBtn);
      return;
    }

    /* Image thumbnails — the thumbnail element IS the <img> */
    var thumb = target.closest('.claude-sessions-image-thumbnail');
    if (thumb) {
      var imgEl = thumb.tagName === 'IMG' ? thumb : thumb.querySelector('img');
      if (imgEl) openImageModal(imgEl.src, imgEl.getAttribute('data-mime'));
      return;
    }

    /* Filter button */
    if (target.closest('#as-filter-btn')) {
      buildFilterMenu();
      return;
    }
  });

  /* Keyboard: Enter/Space on role="button" */
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      var el = e.target;
      if (el && el.getAttribute && el.getAttribute('role') === 'button') {
        e.preventDefault();
        el.click();
      }
    }
    /* Escape closes image modal */
    if (e.key === 'Escape') closeImageModal();
  });

  /* Make all turns visible (no IntersectionObserver in export) */
  document.querySelectorAll('.claude-sessions-turn').forEach(function(t) {
    t.classList.add('visible');
  });
})();`;
}
