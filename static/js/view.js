const planId = window.planId;
const sourceSelect = document.getElementById('sourceSelect');
const destSelect = document.getElementById('destSelect');
const findRouteBtn = document.getElementById('findRouteBtn');
const swapBtn = document.getElementById('swapBtn');
const routeResult = document.getElementById('routeResult');
const mapPanel = document.getElementById('mapPanel');
const planImg = document.getElementById('planImg');
const overlay = document.getElementById('overlay');
const liveNavPanel = document.getElementById('liveNavPanel');
const liveNavBtn = document.getElementById('liveNavBtn');
const liveInstruction = document.getElementById('liveInstruction');
const headingValue = document.getElementById('headingValue');
const positionValue = document.getElementById('positionValue');
const statusValue = document.getElementById('statusValue');

let nodes = {};
let ctx = null;
let routeData = null;
let currentPosition = null;
let currentHeading = 0;
let liveTracking = false;
let permissionGranted = false;
let currentStepIndex = 0;

const STEP_THRESHOLD = 1.12;
const STEP_RESET_RATIO = 0.30;
const MIN_STEP_INTERVAL_MS = 280;
const STEP_LENGTH_SCALE = 0.95;
const PROXIMITY_THRESHOLD = 0.025;

const stepState = {
  filteredAcc: 9.81,
  baseline: 9.81,
  accState: 'idle',
  windowMax: -Infinity,
  windowMin: Infinity,
  lastStepTime: 0
};

async function init() {
  const res = await fetch(`/plan/${planId}/graph`);
  const data = await res.json();

  if (data.error || !data.nodes || data.nodes.length === 0) {
    sourceSelect.innerHTML = '<option>No rooms available</option>';
    destSelect.innerHTML = '<option>No rooms available</option>';
    routeResult.innerHTML = '<div class="error-msg">This plan has no rooms marked yet.</div>';
    return;
  }

  data.nodes.forEach(n => nodes[n.id] = n);

  const opts = data.nodes.map(n => `<option value="${n.id}">${n.name}</option>`).join('');
  sourceSelect.innerHTML = opts;
  destSelect.innerHTML = opts;
  if (data.nodes.length > 1) {
    destSelect.selectedIndex = 1;
  }
  findRouteBtn.disabled = false;

  if (planImg.src) {
    if (planImg.complete && planImg.naturalWidth > 0) {
      setupCanvas();
    } else {
      planImg.onload = setupCanvas;
    }
    mapPanel.style.display = 'block';
  }
}

function setupCanvas() {
  if (!planImg || !planImg.naturalWidth) return;

  overlay.width = planImg.naturalWidth;
  overlay.height = planImg.naturalHeight;
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.left = '0';
  overlay.style.top = '0';
  ctx = overlay.getContext('2d');
  drawOverlay();
}

window.addEventListener('resize', drawOverlay);

function getNodePosition(nodeId) {
  const node = nodes[nodeId];
  if (!node) return null;
  return { x: Number(node.x), y: Number(node.y) };
}

function toDisplayPoint(pos) {
  return { x: pos.x * overlay.width, y: pos.y * overlay.height };
}

function drawOverlay() {
  if (!ctx || !overlay.width) return;

  ctx.clearRect(0, 0, overlay.width, overlay.height);

  if (!routeData || !routeData.path || routeData.path.length < 2) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(79, 140, 166, 0.7)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  routeData.path.forEach((nodeId, index) => {
    const pos = getNodePosition(nodeId);
    if (!pos) return;
    const displayPos = toDisplayPoint(pos);
    if (index === 0) {
      ctx.moveTo(displayPos.x, displayPos.y);
    } else {
      ctx.lineTo(displayPos.x, displayPos.y);
    }
  });
  ctx.stroke();

  routeData.path.forEach((nodeId) => {
    const pos = getNodePosition(nodeId);
    if (!pos) return;
    const displayPos = toDisplayPoint(pos);
    ctx.beginPath();
    ctx.arc(displayPos.x, displayPos.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff6b35';
    ctx.stroke();
  });
  ctx.restore();

  if (currentPosition) {
    drawUserMarker();
  }
}

function drawUserMarker() {
  if (!ctx || !currentPosition) return;

  const displayPos = toDisplayPoint(currentPosition);
  ctx.save();
  ctx.translate(displayPos.x, displayPos.y);
  ctx.rotate((currentHeading * Math.PI) / 180);

  ctx.fillStyle = '#0e2a3d';
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#ff6b35';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(0, 16);
  ctx.moveTo(0, -12);
  ctx.lineTo(-6, -4);
  ctx.moveTo(0, -12);
  ctx.lineTo(6, -4);
  ctx.stroke();
  ctx.restore();
}

function iconForInstruction(instr) {
  if (instr.includes('right')) return '↱';
  if (instr.includes('left')) return '↰';
  if (instr.includes('around')) return '↶';
  if (instr.includes('straight') || instr.includes('Face')) return '↑';
  return '•';
}

function updateGuidance() {
  if (!routeData || !routeData.directions || routeData.directions.length === 0) {
    return;
  }

  if (currentStepIndex >= routeData.directions.length) {
    liveInstruction.textContent = `You have arrived at ${routeData.path_names[routeData.path_names.length - 1]}.`;
    statusValue.textContent = 'Arrived';
    return;
  }

  const step = routeData.directions[currentStepIndex];
  liveInstruction.textContent = `${step.instruction} • toward ${step.to}`;
  statusValue.textContent = liveTracking ? 'Tracking' : 'Ready';
}

function resetLiveTracking() {
  liveTracking = false;
  currentStepIndex = 0;
  currentPosition = null;
  headingValue.textContent = '--';
  positionValue.textContent = '--';
  statusValue.textContent = 'Idle';
  liveNavBtn.textContent = 'Start live navigation';
  drawOverlay();
}

function startLiveNavigation() {
  if (!routeData || !routeData.path || routeData.path.length < 2) {
    liveInstruction.textContent = 'Create a route first before starting live guidance.';
    return;
  }

  if (!permissionGranted) {
    if (typeof DeviceMotionEvent === 'undefined' && typeof DeviceOrientationEvent === 'undefined') {
      liveInstruction.textContent = 'This device does not expose motion sensors.';
      statusValue.textContent = 'Unavailable';
      return;
    }

    liveNavBtn.disabled = true;
    liveNavBtn.textContent = 'Requesting…';
    requestPermissionsIfNeeded().then((granted) => {
      liveNavBtn.disabled = false;
      if (!granted) {
        liveInstruction.textContent = 'Motion access was denied. Please allow it in browser settings.';
        statusValue.textContent = 'Permission denied';
        liveNavBtn.textContent = 'Start live navigation';
        return;
      }

      permissionGranted = true;
      attachSensors();
      beginTracking();
    });
    return;
  }

  beginTracking();
}

function beginTracking() {
  const startNodeId = routeData.path[0];
  const startPos = getNodePosition(startNodeId);
  if (!startPos) {
    return;
  }

  currentPosition = { ...startPos };
  currentStepIndex = 0;
  currentHeading = 0;
  liveTracking = true;
  liveNavBtn.textContent = 'Pause live navigation';
  headingValue.textContent = '--';
  positionValue.textContent = `${Math.round(currentPosition.x)}, ${Math.round(currentPosition.y)}`;
  statusValue.textContent = 'Tracking';
  updateGuidance();
  drawOverlay();
}

function attachSensors() {
  window.addEventListener('devicemotion', handleMotion);
  window.addEventListener('deviceorientation', handleOrientation);
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', handleOrientation);
  }
}

function handleMotion(event) {
  if (!liveTracking) return;

  const acceleration = event.accelerationIncludingGravity;
  if (acceleration && acceleration.x !== null && acceleration.x !== undefined) {
    const magnitude = Math.sqrt(acceleration.x ** 2 + acceleration.y ** 2 + acceleration.z ** 2);
    processAccelSample(magnitude);
  }
}

function processAccelSample(magnitude) {
  stepState.filteredAcc += 0.18 * (magnitude - stepState.filteredAcc);
  stepState.baseline += 0.01 * (stepState.filteredAcc - stepState.baseline);
  const deviation = stepState.filteredAcc - stepState.baseline;

  if (stepState.accState === 'idle' && deviation > STEP_THRESHOLD) {
    stepState.accState = 'above';
    stepState.windowMax = stepState.filteredAcc;
    stepState.windowMin = stepState.filteredAcc;
  } else if (stepState.accState === 'above') {
    if (stepState.filteredAcc > stepState.windowMax) stepState.windowMax = stepState.filteredAcc;
    if (stepState.filteredAcc < stepState.windowMin) stepState.windowMin = stepState.filteredAcc;
    if (deviation < STEP_THRESHOLD * STEP_RESET_RATIO) {
      const now = performance.now();
      if (now - stepState.lastStepTime > MIN_STEP_INTERVAL_MS) {
        registerStep(stepState.windowMax, stepState.windowMin);
        stepState.lastStepTime = now;
      }
      stepState.accState = 'idle';
    }
  }
}

function registerStep(maxValue, minValue) {
  const amplitude = Math.max(maxValue - minValue, 0.25);
  const stepLength = Math.max(0.008, Math.min(0.03, 0.012 + amplitude * 0.004 * STEP_LENGTH_SCALE));
  const headingRadians = (currentHeading * Math.PI) / 180;

  if (currentPosition) {
    currentPosition.x += stepLength * Math.sin(headingRadians);
    currentPosition.y += stepLength * -Math.cos(headingRadians);
    currentPosition.x = Math.max(0, Math.min(1, currentPosition.x));
    currentPosition.y = Math.max(0, Math.min(1, currentPosition.y));
    positionValue.textContent = `${currentPosition.x.toFixed(3)}, ${currentPosition.y.toFixed(3)}`;
  }

  advanceProgress();
  drawOverlay();
}

function advanceProgress() {
  if (!routeData || !currentPosition) return;

  const nextNodeId = routeData.path[currentStepIndex + 1];
  if (!nextNodeId) {
    currentStepIndex = routeData.directions.length;
    updateGuidance();
    return;
  }

  const nextPos = getNodePosition(nextNodeId);
  if (!nextPos) return;

  const dist = Math.hypot(currentPosition.x - nextPos.x, currentPosition.y - nextPos.y);
  if (dist <= PROXIMITY_THRESHOLD) {
    currentStepIndex += 1;
    if (currentStepIndex >= routeData.directions.length) {
      liveTracking = false;
      liveNavBtn.textContent = 'Start live navigation';
      statusValue.textContent = 'Arrived';
      liveInstruction.textContent = `You have arrived at ${routeData.path_names[routeData.path_names.length - 1]}.`;
      return;
    }
  }

  updateGuidance();
}

function handleOrientation(event) {
  let heading = null;

  if (typeof event.webkitCompassHeading === 'number') {
    heading = event.webkitCompassHeading;
  } else if (event.alpha !== null && event.alpha !== undefined) {
    heading = (360 - event.alpha) % 360;
  }

  if (heading !== null) {
    currentHeading = heading;
    headingValue.textContent = `${Math.round(currentHeading)}°`;
    drawOverlay();
  }
}

async function requestPermissionsIfNeeded() {
  let granted = true;

  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const response = await DeviceMotionEvent.requestPermission();
      granted = response === 'granted';
    } catch (error) {
      granted = false;
    }
  }

  if (granted && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const response = await DeviceOrientationEvent.requestPermission();
      granted = response === 'granted';
    } catch (error) {
      granted = false;
    }
  }

  return granted;
}

swapBtn.addEventListener('click', () => {
  const s = sourceSelect.value;
  const d = destSelect.value;
  sourceSelect.value = d;
  destSelect.value = s;
});

findRouteBtn.addEventListener('click', async () => {
  const source = sourceSelect.value;
  const target = destSelect.value;

  if (source === target) {
    routeResult.innerHTML = '<div class="error-msg">Source and destination are the same room.</div>';
    return;
  }

  routeResult.innerHTML = '<p class="hint">Calculating route...</p>';

  const res = await fetch(`/plan/${planId}/path?source=${source}&target=${target}`);
  const data = await res.json();

  if (data.error) {
    routeResult.innerHTML = `<div class="error-msg">${data.error}</div>`;
    liveNavPanel.style.display = 'none';
    resetLiveTracking();
    return;
  }

  routeData = data;
  liveNavPanel.style.display = 'block';
  resetLiveTracking();
  renderRoute(data);
});

liveNavBtn.addEventListener('click', () => {
  if (liveTracking) {
    liveTracking = false;
    liveNavBtn.textContent = 'Resume live navigation';
    statusValue.textContent = 'Paused';
    return;
  }

  startLiveNavigation();
});

function renderRoute(data) {
  let html = `<div class="route-card">
    <div class="route-summary">
      Route: ${data.path_names.join(' → ')}<br>
      Total distance: <span class="dist">${data.total_distance}</span> units
    </div>`;

  data.directions.forEach((step) => {
    html += `<div class="step">
      <div class="step-icon">${iconForInstruction(step.instruction)}</div>
      <div class="step-text">
        <div class="from-to">${step.instruction} — toward <strong>${step.to}</strong></div>
        <div class="meta">from ${step.from} · ${step.distance} units · facing ${step.direction_facing}</div>
      </div>
    </div>`;
  });

  html += `<div class="step">
    <div class="step-icon">●</div>
    <div class="step-text"><div class="from-to">You have arrived at <strong>${data.path_names[data.path_names.length-1]}</strong></div></div>
  </div></div>`;

  routeResult.innerHTML = html;
  drawOverlay();
}

init();
