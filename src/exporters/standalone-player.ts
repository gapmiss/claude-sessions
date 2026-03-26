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
   *   - Turn: "collapsed" class on .agent-sessions-turn
   *   - Everything else: "open" class on the parent container
   * The CSS handles show/hide via these classes.
   */
  function toggleCollapsible(header) {
    var expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));

    /* Turn header: toggle "collapsed" class on turn element */
    var turn = header.closest('.agent-sessions-turn');
    if (turn && header.classList.contains('agent-sessions-turn-header')) {
      turn.classList.toggle('collapsed', expanded); /* expanded=true means collapse */
      return;
    }

    /* All other collapsibles use "open" class on the nearest container.
     * Walk up from the header to find the right parent. */
    var containers = [
      '.agent-sessions-summary',
      '.agent-sessions-tool-block',
      '.agent-sessions-tool-group',
      '.agent-sessions-thinking-block',
      '.agent-sessions-slash-command-block',
      '.agent-sessions-subagent-prompt',
    ];
    for (var i = 0; i < containers.length; i++) {
      var container = header.closest(containers[i]);
      if (container) {
        container.classList.toggle('open', !expanded);
        return;
      }
    }
  }

  /* ── Show more / show less ── */
  function toggleShowMore(btn) {
    var wrap = btn.closest('.agent-sessions-collapsible-wrap');
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
    modalOverlay.className = 'agent-sessions-image-modal-overlay';
    modalOverlay.addEventListener('click', function(e) {
      if (e.target === modalOverlay) closeImageModal();
    });

    var container = document.createElement('div');
    container.className = 'agent-sessions-image-modal-container';

    var img = document.createElement('img');
    img.src = src;
    img.style.maxWidth = '100%';
    img.style.maxHeight = 'calc(85vh - 60px)';
    container.appendChild(img);

    var toolbar = document.createElement('div');
    toolbar.className = 'agent-sessions-image-modal-toolbar';

    var dlBtn = document.createElement('a');
    dlBtn.href = src;
    dlBtn.download = 'image.' + (mime || 'png').split('/').pop();
    dlBtn.textContent = 'Download';
    dlBtn.className = 'agent-sessions-image-modal-btn';
    toolbar.appendChild(dlBtn);

    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'agent-sessions-image-modal-btn';
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

  /* ── Content filter menu ── */
  function buildFilterMenu() {
    var btn = document.getElementById('as-filter-btn');
    if (!btn) return;

    var menu = document.getElementById('as-filter-menu');
    if (menu) { menu.remove(); return; }

    menu = document.createElement('div');
    menu.id = 'as-filter-menu';
    menu.className = 'agent-sessions-filter-menu';

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
      row.className = 'agent-sessions-filter-row' + (f.parent ? ' parent' : ' child');
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

    /* User turns */
    root.querySelectorAll('.agent-sessions-turn-role-user').forEach(function(turn) {
      turn.style.display = state.user === false ? 'none' : '';
      if (state.user !== false) {
        turn.querySelectorAll('.agent-sessions-text-block').forEach(function(b) {
          if (b.closest('.agent-sessions-turn-role-assistant')) return;
          b.style.display = state.userText === false ? 'none' : '';
        });
        turn.querySelectorAll('.agent-sessions-image-thumbnail').forEach(function(b) {
          b.style.display = state.userImages === false ? 'none' : '';
        });
      }
    });

    /* Assistant turns */
    root.querySelectorAll('.agent-sessions-turn-role-assistant').forEach(function(turn) {
      turn.style.display = state.assistant === false ? 'none' : '';
      if (state.assistant !== false) {
        turn.querySelectorAll('.agent-sessions-text-block').forEach(function(b) {
          b.style.display = state.assistantText === false ? 'none' : '';
        });
        turn.querySelectorAll('.agent-sessions-thinking-block').forEach(function(b) {
          b.style.display = state.thinking === false ? 'none' : '';
        });
        turn.querySelectorAll('.agent-sessions-tool-block').forEach(function(b) {
          b.style.display = state.toolCalls === false ? 'none' : '';
        });
        turn.querySelectorAll('.agent-sessions-tool-group').forEach(function(b) {
          b.style.display = state.toolCalls === false ? 'none' : '';
        });
        turn.querySelectorAll('.agent-sessions-tool-result').forEach(function(b) {
          b.style.display = state.toolResults === false ? 'none' : '';
        });
      }
    });
  }

  /* ── Event delegation ── */
  document.addEventListener('click', function(e) {
    var target = e.target;

    /* Walk up to find interactive element */
    var el = target.closest('[role="button"][aria-expanded]');
    if (el && document.getElementById('as-export-root')?.contains(el)) {
      toggleCollapsible(el);
      return;
    }

    /* Show more button */
    var showBtn = target.closest('.agent-sessions-show-more-btn');
    if (showBtn) {
      e.preventDefault();
      toggleShowMore(showBtn);
      return;
    }

    /* Copy buttons */
    var copyBtn = target.closest('.agent-sessions-copy-btn, .agent-sessions-summary-copy, .copy-code-button');
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

    /* Image thumbnails */
    var thumb = target.closest('.agent-sessions-image-thumbnail');
    if (thumb) {
      var img = thumb.querySelector('img');
      if (img) openImageModal(img.src, thumb.getAttribute('data-mime'));
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
  document.querySelectorAll('.agent-sessions-turn').forEach(function(t) {
    t.classList.add('visible');
  });
})();`;
}
