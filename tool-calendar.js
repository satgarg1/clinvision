/* Shared date picker for the Free Health Tools pages. Reuses the exact
   .time-picker / .rx-cal-* classes and grid behaviour from the Write
   Prescription follow-up date picker (doctor.html) -- same app look, just
   without the "In 7 days" style shortcut row, since these are one-off
   entries (a reading date, a last period date) rather than a follow-up. */
window.ToolCalendar = (function () {
  function pad(n) { return String(n).padStart(2, '0'); }
  function toVal(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
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
    var value = cfg.initialValue || '';
    var viewDate = value ? new Date(value + 'T00:00:00') : new Date();

    function updateText() {
      if (!value) {
        textEl.textContent = cfg.placeholder || 'Choose a date';
        trigger.classList.add('placeholder');
        return;
      }
      trigger.classList.remove('placeholder');
      var d = new Date(value + 'T00:00:00');
      textEl.textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function render() {
      var y = viewDate.getFullYear(), m = viewDate.getMonth();
      var first = new Date(y, m, 1);
      var daysInMonth = new Date(y, m + 1, 0).getDate();
      var todayStr = toVal(new Date());
      var cells = '';
      for (var i = 0; i < first.getDay(); i++) cells += '<div class="rx-cal-cell empty"></div>';
      for (var day = 1; day <= daysInMonth; day++) {
        var d = new Date(y, m, day);
        var dStr = toVal(d);
        var future = cfg.disableFuture && dStr > todayStr;
        var classes = ['rx-cal-cell'];
        if (dStr === todayStr) classes.push('today');
        if (dStr === value) classes.push('selected');
        if (future) classes.push('past');
        cells += '<div class="' + classes.join(' ') + '" ' + (future ? '' : 'data-date="' + dStr + '"') + '>' + day + '</div>';
      }
      panel.innerHTML =
        '<div class="rx-cal-nav">' +
          '<button type="button" class="rx-cal-nav-btn" data-nav="prev">&lsaquo;</button>' +
          '<div class="rx-cal-month-label">' + first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + '</div>' +
          '<button type="button" class="rx-cal-nav-btn" data-nav="next">&rsaquo;</button>' +
        '</div>' +
        '<div class="rx-cal-weekdays">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>' +
        '<div class="rx-cal-grid">' + cells + '</div>';
    }

    function open() {
      viewDate = value ? new Date(value + 'T00:00:00') : new Date();
      render();
      panel.classList.toggle('flip-up', shouldFlipUp(trigger, 320));
      panel.style.display = 'block';
    }
    function close() { panel.style.display = 'none'; }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel.style.display === 'block') close(); else open();
    });
    panel.addEventListener('click', function (e) {
      e.stopPropagation();
      var navBtn = e.target.closest('[data-nav]');
      if (navBtn) {
        var y = viewDate.getFullYear(), m = viewDate.getMonth();
        viewDate = new Date(y, navBtn.dataset.nav === 'prev' ? m - 1 : m + 1, 1);
        render();
        return;
      }
      var cell = e.target.closest('.rx-cal-cell[data-date]');
      if (cell) {
        value = cell.dataset.date;
        updateText();
        close();
        if (cfg.onChange) cfg.onChange(value);
      }
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
