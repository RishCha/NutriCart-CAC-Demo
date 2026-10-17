(() => {
  const genericFailure = "We could not confirm delivery. Please try again later.";
  const cooldownFailure = "Please wait a minute before sending another feedback response.";
  const cooldownKey = "nutricart:feedback-cooldown-until";
  const cooldownDuration = 60 * 1000;
  function readableFailure(data) {
    const readable = value => typeof value === "string" && value.trim() ? value.trim() : "";
    if (readable(data)) return readable(data);
    if (!data || typeof data !== "object" || Array.isArray(data)) return genericFailure;
    return readable(data.error) || readable(data.message) || readable(data.error?.message) || genericFailure;
  }
  const dialog = document.querySelector("#feedback-dialog");
  const title = document.querySelector("#feedback-title");
  const support = document.querySelector("#feedback-support");
  const ratingStep = document.querySelector("#feedback-rating");
  const form = document.querySelector("#feedback-form");
  const comment = document.querySelector("#feedback-comment");
  const submit = document.querySelector("#feedback-submit");
  const skip = document.querySelector("#feedback-skip");
  const back = document.querySelector("#feedback-back");
  const status = document.querySelector("#feedback-status");
  const thanks = document.querySelector("#feedback-thanks");
  const done = document.querySelector("#feedback-done");
  const cooldown = document.querySelector("#feedback-cooldown");
  const cooldownDone = document.querySelector("#feedback-cooldown-done");
  let rating = null, enabled = false, token = "", pending = false, delivered = false, opener = null;
  let cooldownUntil = 0, cooldownActive = false;
  let availability = "Checking feedback availability...";
  function refreshCooldown() {
    try {
      const stored = Number(sessionStorage.getItem(cooldownKey));
      if (Number.isFinite(stored)) cooldownUntil = Math.max(cooldownUntil, stored);
    } catch {}
    if (cooldownUntil > Date.now()) return true;
    cooldownUntil = 0;
    try { sessionStorage.removeItem(cooldownKey); } catch {}
    return false;
  }
  function startCooldown() {
    cooldownUntil = Date.now() + cooldownDuration;
    cooldownActive = true;
    try { sessionStorage.setItem(cooldownKey, String(cooldownUntil)); } catch {}
  }
  function render() {
    ratingStep.hidden = Boolean(rating) || delivered || cooldownActive;
    form.hidden = !rating || delivered || cooldownActive;
    thanks.hidden = !delivered;
    cooldown.hidden = !cooldownActive || delivered;
    title.textContent = delivered ? "Thank you for helping us improve NutriCart!" : cooldownActive ? cooldownFailure : !rating ? "How was your NutriCart experience?" : rating === "positive" ? "What did you like about NutriCart?" : "What could we improve?";
    support.textContent = delivered ? "Your feedback has been submitted." : cooldownActive ? "You can send more feedback shortly." : rating ? "We value your feedback." : "Your feedback helps make NutriCart better.";
    submit.disabled = cooldownActive || !enabled || pending || !comment.value.trim();
    skip.disabled = cooldownActive || !enabled || pending;
    back.disabled = pending;
    comment.disabled = pending;
  }
  document.querySelectorAll("[data-open-feedback]").forEach(button => button.addEventListener("click", async () => {
    opener = button;
    cooldownActive = refreshCooldown();
    status.textContent = "";
    dialog.showModal(); render(); title.focus();
    if (cooldownActive) return;
    try {
      const response = await fetch("/api/feedback", {cache: "no-store", credentials: "same-origin"});
      if (!response.ok) throw new Error();
      const data = await response.json();
      enabled = data.enabled === true; token = data.csrf_token;
      availability = enabled ? "" : "Feedback sending is not configured.";
    } catch { enabled = false; availability = "Feedback is unavailable right now."; }
    if (!pending) status.textContent = availability;
    render();
  }));
  document.querySelectorAll("[data-rating]").forEach(button => button.addEventListener("click", () => {
    rating = button.dataset.rating; status.textContent = availability; render(); title.focus();
  }));
  back.addEventListener("click", () => { rating = null; render(); ratingStep.querySelector("button").focus(); });
  comment.addEventListener("input", render);
  done.addEventListener("click", () => dialog.close());
  cooldownDone.addEventListener("click", () => dialog.close());
  document.querySelector("#feedback-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (!pending) { rating = null; delivered = false; comment.value = ""; status.textContent = ""; render(); }
    opener?.focus();
  });
  async function deliver(feedbackComment) {
    if (!enabled || pending || !rating) return;
    pending = true; status.textContent = "Sending feedback..."; render();
    let failureMessage = genericFailure;
    try {
      const response = await fetch("/api/feedback", {method: "POST", credentials: "same-origin",
        headers: {"Content-Type": "application/json", "X-CSRF-Token": token},
        body: JSON.stringify({rating, comment: feedbackComment})});
      if (response.status === 429) {
        failureMessage = cooldownFailure;
        startCooldown();
        throw new Error();
      }
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok || data?.delivered !== true) {
        failureMessage = readableFailure(data);
        throw new Error();
      }
      startCooldown();
      delivered = true; comment.value = ""; status.textContent = "";
      if (dialog.open) title.focus();
    } catch { status.textContent = cooldownActive ? "" : failureMessage; }
    finally {
      pending = false;
      if (!dialog.open) { rating = null; delivered = false; comment.value = ""; status.textContent = ""; }
      render();
    }
  }
  skip.addEventListener("click", () => deliver(""));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const writtenComment = comment.value.trim();
    if (writtenComment) deliver(writtenComment);
  });
})();
