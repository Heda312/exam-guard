/** Extension popup: read-only status view with a manual stop action. */

const statusEl = document.getElementById("status");
const examEl = document.getElementById("exam");
const sessionEl = document.getElementById("session");
const bufferedEl = document.getElementById("buffered");
const stopButton = document.getElementById("stop");

function render(state) {
  const { session, buffered } = state;
  bufferedEl.textContent = String(buffered ?? 0);

  if (!session) {
    statusEl.innerHTML = '<span class="badge badge-off">Tidak ada sesi</span>';
    examEl.textContent = "—";
    sessionEl.textContent = "—";
    stopButton.disabled = true;
    return;
  }

  if (session.needsAttention) {
    statusEl.innerHTML = '<span class="badge badge-warn">Perlu tindakan</span>';
  } else if (session.monitoring) {
    statusEl.innerHTML = '<span class="badge badge-on">Memantau</span>';
  } else {
    statusEl.innerHTML = '<span class="badge badge-off">Menunggu</span>';
  }

  examEl.textContent = session.examCode ?? "—";
  sessionEl.textContent = session.participantSessionId
    ? `${session.participantSessionId.slice(0, 8)}…`
    : "—";
  stopButton.disabled = !session.monitoring;
}

async function refresh() {
  chrome.runtime.sendMessage({ type: "get_state" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      statusEl.innerHTML = '<span class="badge badge-warn">Tidak dapat membaca status</span>';
      return;
    }
    render(response);
  });
}

stopButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop_monitoring" }, () => {
    void refresh();
  });
});

void refresh();
setInterval(refresh, 3000);
