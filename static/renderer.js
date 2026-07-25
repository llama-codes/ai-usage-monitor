const interaction = document.querySelector("#interaction");
const clicks = document.querySelector("#clicks");
const ticks = document.querySelector("#ticks");
const refreshes = document.querySelector("#refreshes");
const status = document.querySelector("#status");

function render(state) {
  clicks.textContent = String(state.buttonClicks);
  ticks.textContent = String(state.backgroundTicks);
  refreshes.textContent = String(state.refreshes);
}

interaction.addEventListener("click", async () => {
  const state = await window.spike.recordButtonClick();
  render(state);
  status.textContent = `Interaction ${state.buttonClicks} recorded`;
});

window.spike.onState(render);
window.spike.getState().then(render);
