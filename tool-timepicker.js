/* Shared 30-minute time picker for the Free Health Tools pages. Reuses the
   exact .time-picker / .time-picker-option classes and open/close behaviour
   from reception.html's appointment time picker, instead of the browser's
   native <input type="time"> control. */
window.ToolTimePicker = (function () {
  function pad(n) { return String(n).padStart(2, '0'); }
  function formatLabel(h, m) {
    var period = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + pad(m) + ' ' + period;
  }
  function buildOptions() {
    var opts = [];
    for (var mins = 0; mins < 24 * 60; mins += 30) {
      var h = Math.floor(mins / 60), m = mins % 60;
      opts.push({ value: pad(h) + ':' + pad(m), label: formatLabel(h, m) });
    }
    return opts;
  }
  function shouldFlipUp(triggerEl, estimatedPanelHeight) {
    var rect = triggerEl.getBoundingClientRect();
    var spaceBelow = window.innerHeight - rect.bottom;
    var spaceAbove = rect.top;
    return spaceBelow < estimatedPanelHeight && spaceAbove > spaceBelow;
  }

  function init(cfg) {
    var wrap = document.getElementById(cfg.wrapId);
    var trigger = document.getElementById(cfg.triggerId);
    var textEl = document.getElementById(cfg.textId);
    var panel = document.getElementById(cfg.panelId);
    var options = buildOptions();
    var value = cfg.initialValue || '';

    function labelFor(v) {
      var found = options.filter(function (o) { return o.value === v; })[0];
      return found ? found.label : v;
    }
    function updateText() {
      if (!value) {
        textEl.textContent = cfg.placeholder || 'Select a time';
        trigger.classList.add('placeholder');
        return;
      }
      trigger.classList.remove('placeholder');
      textEl.textContent = labelFor(value);
    }
    function render() {
      panel.innerHTML = options.map(function (o) {
        return '<div class="time-picker-option' + (o.value === value ? ' selected' : '') + '" data-value="' + o.value + '" data-label="' + o.label + '">' + o.label + '</div>';
      }).join('');
    }
    function open() {
      render();
      panel.classList.toggle('flip-up', shouldFlipUp(trigger, 260));
      panel.style.display = 'block';
      var target = panel.querySelector('.selected') || panel.querySelector('.time-picker-option');
      if (target) target.scrollIntoView({ block: 'nearest' });
    }
    function close() { panel.style.display = 'none'; }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.style.display === 'block') close(); else open();
    });
    panel.addEventListener('click', function (e) {
      var opt = e.target.closest('.time-picker-option');
      if (!opt) return;
      value = opt.getAttribute('data-value');
      updateText();
      close();
      if (cfg.onChange) cfg.onChange(value);
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    updateText();
    return {
      getValue: function () { return value; },
      setValue: function (v) { value = v; updateText(); }
    };
  }

  return { init: init };
})();
