(function() {
  'use strict';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'グラス歩数計',
    storageKey: 'mdg_glass_pedometer',
    defaultGoal: 6000,
    minGoal: 1000,
    maxGoal: 50000,
    strideMeters: 0.7,
    kcalPerStep: 0.04,
    ringCircumference: 565.48,
    stepThreshold: 1.2,
    stepReleaseThreshold: 0.5,
    minStepIntervalMs: 300,
    demoIntervalMs: 1800,
    motionWatchdogMs: 2500,
  };

  // ==================== STATE ====================
  var state = {
    currentScreen: 'home',
    screenHistory: [],
    data: {
      date: '',
      steps: 0,
      goal: CONFIG.defaultGoal,
      goalCelebrated: false,
    },
    tracking: false,
    mode: null, // 'motion' | 'demo'
    motionBaseline: null,
    motionRising: false,
    lastStepTime: 0,
    demoTimer: null,
    motionWatchdogTimer: null,
    motionEventReceived: false,
  };

  // ==================== DOM REFS ====================
  var screens = {};

  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function(s) {
      if (s.id) screens[s.id] = s;
    });
  }

  // ==================== NAVIGATION ====================
  function navigateTo(screenId, options) {
    options = options || {};
    var addToHistory = options.addToHistory !== false;

    if (addToHistory && state.currentScreen) {
      state.screenHistory.push(state.currentScreen);
    }

    Object.values(screens).forEach(function(s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      onScreenEnter(screenId);
      focusFirst(screens[screenId]);
    }
  }

  function navigateBack() {
    if (state.screenHistory.length > 0) {
      navigateTo(state.screenHistory.pop(), { addToHistory: false });
    } else {
      navigateTo('home', { addToHistory: false });
    }
  }

  // ==================== FOCUS MANAGEMENT ====================
  function focusFirst(container) {
    var el = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (el) el.focus();
  }

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;

    var focusables = Array.from(
      container.querySelectorAll('.focusable:not([disabled]):not(.hidden)')
    );
    if (focusables.length === 0) return;

    var current = document.activeElement;
    var idx = focusables.indexOf(current);

    if (idx === -1) {
      focusFirst(container);
      return;
    }

    var nextIdx;
    if (direction === 'up' || direction === 'left') {
      nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    } else {
      nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    }
    focusables[nextIdx].focus();

    var scrollParent = focusables[nextIdx].closest('.content, .list-container');
    if (scrollParent) {
      focusables[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ==================== UI HELPERS ====================
  function showToast(message, type) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.offsetHeight;
    toast.classList.add('visible');
    setTimeout(function() { toast.classList.remove('visible'); }, 2500);
  }

  // ==================== DATA PERSISTENCE ====================
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function loadData() {
    try {
      var saved = localStorage.getItem(CONFIG.storageKey);
      if (saved) {
        var parsed = JSON.parse(saved);
        Object.assign(state.data, parsed);
      }
    } catch (e) {
      console.error('[Storage] Load error:', e);
    }
    ensureFreshDay();
  }

  function saveData() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.data));
    } catch (e) {
      console.error('[Storage] Save error:', e);
    }
  }

  function ensureFreshDay() {
    var today = todayStr();
    if (state.data.date !== today) {
      state.data.date = today;
      state.data.steps = 0;
      state.data.goalCelebrated = false;
      saveData();
    }
  }

  // ==================== STEP TRACKING ====================
  function registerStep() {
    ensureFreshDay();
    state.data.steps += 1;
    saveData();
    renderHome();

    if (!state.data.goalCelebrated && state.data.steps >= state.data.goal) {
      state.data.goalCelebrated = true;
      saveData();
      showToast('🎉 目標達成！ ' + state.data.goal + '歩', 'success');
    }
  }

  function handleMotionEvent(e) {
    var acc = e.accelerationIncludingGravity || e.acceleration;
    if (!acc || acc.x === null) return;

    state.motionEventReceived = true;

    var mag = Math.sqrt(
      (acc.x || 0) * (acc.x || 0) +
      (acc.y || 0) * (acc.y || 0) +
      (acc.z || 0) * (acc.z || 0)
    );

    if (state.motionBaseline === null) {
      state.motionBaseline = mag;
      return;
    }
    state.motionBaseline = state.motionBaseline * 0.9 + mag * 0.1;

    var delta = mag - state.motionBaseline;
    var now = Date.now();

    if (
      delta > CONFIG.stepThreshold &&
      !state.motionRising &&
      (now - state.lastStepTime) > CONFIG.minStepIntervalMs
    ) {
      state.motionRising = true;
      state.lastStepTime = now;
      registerStep();
    } else if (delta < CONFIG.stepReleaseThreshold) {
      state.motionRising = false;
    }
  }

  function attachMotion() {
    state.mode = 'motion';
    state.motionBaseline = null;
    state.motionRising = false;
    state.motionEventReceived = false;
    window.addEventListener('devicemotion', handleMotionEvent);
    setStatus('計測中');

    clearMotionWatchdog();
    state.motionWatchdogTimer = setTimeout(function() {
      if (state.tracking && !state.motionEventReceived) {
        detachMotion();
        startDemoMode();
      }
    }, CONFIG.motionWatchdogMs);
  }

  function detachMotion() {
    window.removeEventListener('devicemotion', handleMotionEvent);
    clearMotionWatchdog();
  }

  function clearMotionWatchdog() {
    if (state.motionWatchdogTimer) {
      clearTimeout(state.motionWatchdogTimer);
      state.motionWatchdogTimer = null;
    }
  }

  function startDemoMode() {
    state.mode = 'demo';
    setStatus('デモモード');
    stopDemoTimer();
    state.demoTimer = setInterval(function() {
      registerStep();
    }, CONFIG.demoIntervalMs);
  }

  function stopDemoTimer() {
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
    }
  }

  function startTracking() {
    if (state.tracking) return;
    state.tracking = true;

    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then(function(response) {
        if (response === 'granted') {
          attachMotion();
        } else {
          showToast('モーションセンサーの許可がありません', 'error');
          startDemoMode();
        }
      }).catch(function() {
        startDemoMode();
      });
    } else if (window.DeviceMotionEvent) {
      attachMotion();
    } else {
      startDemoMode();
    }

    updateToggleButton();
  }

  function stopTracking() {
    state.tracking = false;
    detachMotion();
    stopDemoTimer();
    state.mode = null;
    setStatus('一時停止');
    updateToggleButton();
  }

  function toggleTracking() {
    if (state.tracking) {
      stopTracking();
    } else {
      startTracking();
    }
  }

  function setStatus(text) {
    var el = document.getElementById('status-indicator');
    if (el) el.textContent = text;
  }

  function updateToggleButton() {
    var btn = document.getElementById('toggle-btn');
    if (!btn) return;
    btn.textContent = state.tracking ? '一時停止 ❚❚' : '計測開始 ▶';
  }

  // ==================== RENDER ====================
  function renderHome() {
    ensureFreshDay();
    var steps = state.data.steps;
    var goal = state.data.goal;
    var percent = Math.min(steps / goal, 1);

    var stepsEl = document.getElementById('steps-value');
    if (stepsEl) stepsEl.textContent = steps;

    var goalEl = document.getElementById('goal-value');
    if (goalEl) goalEl.textContent = goal;

    var percentEl = document.getElementById('steps-percent');
    if (percentEl) percentEl.textContent = Math.round(percent * 100) + '%';

    var ring = document.getElementById('ring-fill');
    if (ring) {
      var offset = CONFIG.ringCircumference * (1 - percent);
      ring.style.strokeDashoffset = offset;
      ring.classList.toggle('goal-reached', percent >= 1);
    }

    var distanceKm = (steps * CONFIG.strideMeters) / 1000;
    var distanceEl = document.getElementById('distance-value');
    if (distanceEl) distanceEl.textContent = distanceKm.toFixed(2) + ' km';

    var calories = Math.round(steps * CONFIG.kcalPerStep);
    var calorieEl = document.getElementById('calorie-value');
    if (calorieEl) calorieEl.textContent = calories + ' kcal';

    updateToggleButton();
    if (!state.tracking) setStatus('停止中');
  }

  function renderSettings() {
    var goalDisplay = document.getElementById('goal-display-value');
    if (goalDisplay) goalDisplay.textContent = state.data.goal;
  }

  function adjustGoal(delta) {
    var next = state.data.goal + delta;
    next = Math.max(CONFIG.minGoal, Math.min(CONFIG.maxGoal, next));
    state.data.goal = next;
    if (state.data.steps < state.data.goal) {
      state.data.goalCelebrated = false;
    }
    saveData();
    renderSettings();
  }

  function resetToday() {
    state.data.steps = 0;
    state.data.goalCelebrated = false;
    saveData();
    showToast('今日の歩数をリセットしました');
    renderHome();
  }

  // ==================== ACTION HANDLING ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back':
        navigateBack();
        break;
      case 'go-settings':
        navigateTo('settings');
        break;
      case 'toggle-tracking':
        toggleTracking();
        break;
      case 'goal-plus-100':
        adjustGoal(100);
        break;
      case 'goal-plus-1000':
        adjustGoal(1000);
        break;
      case 'goal-minus-100':
        adjustGoal(-100);
        break;
      case 'goal-minus-1000':
        adjustGoal(-1000);
        break;
      case 'reset-today':
        resetToday();
        break;
      default:
        break;
    }
  }

  function onScreenEnter(screenId) {
    if (screenId === 'home') {
      renderHome();
    } else if (screenId === 'settings') {
      renderSettings();
    }
  }

  // ==================== EVENT LISTENERS ====================
  function setupEvents() {
    document.addEventListener('click', function(e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowUp':
          moveFocus('up');
          e.preventDefault();
          break;
        case 'ArrowDown':
          moveFocus('down');
          e.preventDefault();
          break;
        case 'ArrowLeft':
          moveFocus('left');
          e.preventDefault();
          break;
        case 'ArrowRight':
          moveFocus('right');
          e.preventDefault();
          break;
        case 'Enter':
          if (document.activeElement &&
              document.activeElement.classList.contains('focusable')) {
            document.activeElement.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          navigateBack();
          e.preventDefault();
          break;
      }
    });

    document.addEventListener('visibilitychange', function() {
      if (document.hidden && state.tracking) {
        stopTracking();
      }
    });
  }

  // ==================== INITIALIZATION ====================
  function init() {
    collectScreens();
    setupEvents();
    loadData();

    setTimeout(function() {
      navigateTo('home', { addToHistory: false });
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
