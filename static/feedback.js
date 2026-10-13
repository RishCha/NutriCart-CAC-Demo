(() => {
  const genericFailure = "We could not confirm delivery. Please try again later.";
  const cooldownFailure = "Please wait a minute before sending another feedback response.";
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
  let rating = null, enabled = false, token = "", pending = false, delivered = false, opener = null;
  let availability = "Checking feedback availability...";
  function render() {
    ratingStep.hidden = Boolean(rating) || delivered;
    form.hidden = !rating || delivered;
    thanks.hidden = !delivered;
    title.textContent = delivered ? "Thank you for helping us improve NutriCart!" : !rating ? "How was your NutriCart experience?" : rating === "positive" ? "What did you like about NutriCart?" : "What could we improve?";
    support.textContent = delivered ? "Your feedback has been submitted." : rating ? "We value your feedback." : "Your feedback helps make NutriCart better.";
    submit.disabled = !enabled || pending || !comment.value.trim();
    skip.disabled = !enabled || pending;
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
  comment.addEventListener("input", render);
  done.addEventListener("click", () => dialog.close());
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
        throw new Error();
      }
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok || data?.delivered !== true) {
        failureMessage = readableFailure(data);
        throw new Error();
      }
      delivered = true; comment.value = ""; status.textContent = "";
      if (dialog.open) title.focus();
    } catch { status.textContent = failureMessage; }
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
