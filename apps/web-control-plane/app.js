async function loadProjection(name) {
  const response = await fetch(`/api/projections/${name}`);
  if (!response.ok) {
    throw new Error(`Failed to load projection ${name}: ${response.status}`);
  }
  const body = await response.json();
  if (!body.ok) {
    throw new Error(body.error || `Projection ${name} returned an error.`);
  }
  return body.projection;
}

function renderJson(target, value) {
  target.textContent = JSON.stringify(value, null, 2);
}

function renderSummaryCards(target, summary) {
  target.innerHTML = '';
  for (const [key, value] of Object.entries(summary || {})) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${key}</h3><p>${String(value)}</p>`;
    target.appendChild(card);
  }
}

async function boot() {
  const root = document.getElementById('projection-root');
  const summaryRoot = document.getElementById('projection-summary');
  const projectionName = document.body.dataset.projection;
  if (!root || !summaryRoot || !projectionName) return;
  try {
    const projection = await loadProjection(projectionName);
    renderSummaryCards(summaryRoot, projection.summary || projection.projections || {});
    renderJson(root, projection);
  } catch (error) {
    root.textContent = error instanceof Error ? error.message : String(error);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  void boot();
});
