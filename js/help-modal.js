import { el } from './dom.js';

/** @type {Record<string, HTMLDivElement>} */
const panels = {
  shortcuts: el.helpPanelShortcuts,
  changelog: el.helpPanelChangelog
};

function setActiveTab(tab) {
  el.helpTabs.querySelectorAll('.help-tab').forEach((btn) => {
    btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.tab === tab);
  });
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== tab;
  }
}

export function openHelpModal() {
  el.helpModal.classList.add('visible');
}

export function closeHelpModal() {
  el.helpModal.classList.remove('visible');
}

export function initHelpModal() {
  el.helpButton.addEventListener('click', openHelpModal);
  el.helpModalClose.addEventListener('click', closeHelpModal);
  el.helpModal.addEventListener('click', (e) => {
    if (e.target === el.helpModal) closeHelpModal();
  });
  el.helpTabs.querySelectorAll('.help-tab').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(/** @type {HTMLElement} */ (btn).dataset.tab));
  });
}
