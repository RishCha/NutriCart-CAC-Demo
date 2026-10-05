(() => {
  const dialog = document.querySelector("#feedback-dialog");
  const title = document.querySelector("#feedback-title");
  const ratingStep = document.querySelector("#feedback-rating");
  const form = document.querySelector("#feedback-form");
  const comment = document.querySelector("#feedback-comment");
  const submit = document.querySelector("#feedback-submit");
  const back = document.querySelector("#feedback-back");
  const status = document.querySelector("#feedback-status");
  const thanks = document.querySelector("#feedback-thanks");
  let rating = null, enabled = false, token = "", pending = false, opener = null;
  let availability = "Checking feedback availability...";
  function render() {
    ratingStep.hidden = Boolean(rating) || !thanks.hidden;
    form.hidden = !rating || !thanks.hidden;
    title.textContent = !thanks.hidden ? "Feedback" : !rating ? "How was your NutriCart experience?" : rating === "positive" ? "What did you like about NutriCart?" : "What could we improve?";
    submit.disabled = !enabled || pending;
    back.disabled = pending;
    comment.disabled = pending;
  }
  document.querySelectorAll("[data-open-feedback]").forEach(button => button.addEventListener("click", async () => {
    opener = button;
    dialog.showModal(); render(); title.focus();
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
  document.querySelector("#feedback-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (!pending) { rating = null; comment.value = ""; thanks.hidden = true; render(); }
    opener?.focus();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!enabled || pending || !rating) return;
    pending = true; status.textContent = "Sending feedback..."; render();
    try {
      const response = await fetch("/api/feedback", {method: "POST", credentials: "same-origin",
        headers: {"Content-Type": "application/json", "X-CSRF-Token": token},
        body: JSON.stringify({rating, comment: comment.value.trim()})});
      const data = await response.json();
      if (!response.ok || data.delivered !== true) throw new Error(data.error || "We could not confirm delivery. Please try again later.");
      thanks.hidden = false; comment.value = "";
      if (dialog.open) title.focus();
    } catch (error) { status.textContent = error.message || "We could not confirm delivery. Please try again later."; }
    finally {
      pending = false;
      if (!dialog.open) { rating = null; comment.value = ""; thanks.hidden = true; }
      render();
    }
  });
})();
