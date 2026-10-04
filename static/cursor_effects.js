(() => {
  // NutriCart Contextual Food Cursor Effects Controller
  // Renders lightweight canvas emoji trails and burst particles on interactive controls.
  // Gated by: (pointer: fine), !reducedMotion, document visibility, and user settings.
  // Event contracts:
  //   Listens: 'nutricart:settings-changed' (for cursorEffects, cursorTrail, clickEffects, reset)
  const finePointer = window.matchMedia("(pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!finePointer.matches) return;

  const MAX_PARTICLES = 22;
  const MAX_TRAIL_PARTICLES = 14;
  const MAX_CLICK_PARTICLES = 16;
  const MAX_CLICK_BURST = 8;
  const TRAIL_INTERVAL_MS = 75;
  const CLICK_INTERVAL_MS = 90;
  const MIN_TRAIL_DISTANCE = 18;
  const CLICK_SIZE_BONUS = 2;
  const emojiFont = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  const TRAIL_PRESETS = {
    planner: ["🥦", "🥕", "🍅", "🧅", "🌽", "🥬", "🍎", "🍋"],
    meal: ["🍽️", "🥣", "🍴", "🥕", "🥦"],
    budget: ["💲", "💲", "🪙", "🪙", "🧾", "🧮", "💵", "🏷️"],
    snap: ["📍", "📍", "🛒", "🛒", "🧭", "🏪", "🗺️"],
  };
  const CURSOR_CONTEXT_PRESETS = {
    planner: ["🥦", "🥕", "🍎", "🛒"],
    meal: ["🍽️", "🥣", "🍴", "🥗"],
    budget: ["💲", "🧾", "🪙", "🛒"],
    snap: ["📍", "🏪", "🧭", "🗺️"],
    account: ["👤", "🔒", "✨"],
    settings: ["⚙️", "✨"],
  };
  const EFFECT_PRESETS = {
    default: {emojis: ["🍲", "🥗", "🥘", "🍜", "🌮", "✨"], count: 10, speed: [105, 190], size: [17, 24], gravity: 245, lifetime: [650, 950], opacity: [.55, .7]},
    review: {emojis: ["🔎", "🔍", "🔎", "🔍", "✨"], count: 10, speed: [100, 185], size: [16, 22], gravity: 235, lifetime: [620, 900], opacity: [.58, .72]},
    "generate-plan": {emojis: ["👀", "👀", "👀", "👀", "✨", "🥕", "🥦", "🍅"], count: 13, speed: [110, 205], size: [16, 23], gravity: 240, lifetime: [650, 930], opacity: [.58, .73]},
    "alternative-plan": {emojis: ["🔄", "🔄", "🔄", "👀", "✨", "🥕", "🥦"], count: 11, speed: [105, 195], size: [16, 22], gravity: 240, lifetime: [630, 920], opacity: [.56, .72]},
    "compare-prices": {emojis: ["💲", "🏪", "🔎", "✨"], count: 11, speed: [105, 195], size: [16, 22], gravity: 240, lifetime: [630, 920], opacity: [.57, .72]},
    "create-meal-plan": {emojis: ["🍽️", "🥣", "🥗", "✨"], count: 11, speed: [105, 195], size: [16, 23], gravity: 240, lifetime: [640, 930], opacity: [.58, .73]},
    "add-purchase": {emojis: ["💲", "💲", "💵", "🧾", "🪙", "✨"], count: 11, speed: [105, 190], size: [15, 22], gravity: 250, lifetime: [620, 900], opacity: [.56, .72]},
    "update-budget": {emojis: ["🧮", "🧮", "🧮", "💲", "✨"], count: 9, speed: [95, 175], size: [15, 21], gravity: 245, lifetime: [600, 880], opacity: [.55, .7]},
    "enter-budget": {emojis: ["🧮", "💵", "💲", "✨"], count: 11, speed: [105, 195], size: [16, 22], gravity: 240, lifetime: [630, 920], opacity: [.58, .73]},
    "create-plan": {emojis: ["🛒", "🛒", "🥕", "🥦", "✨"], count: 10, speed: [105, 190], size: [16, 22], gravity: 240, lifetime: [620, 900], opacity: [.56, .72]},
    location: {emojis: ["📍", "📍", "📍", "🧭", "✨"], count: 10, speed: [100, 185], size: [15, 22], gravity: 235, lifetime: [620, 900], opacity: [.57, .72]},
    "address-search": {emojis: ["🔎", "🔎", "📍", "🗺️"], count: 9, speed: [95, 180], size: [15, 21], gravity: 235, lifetime: [610, 890], opacity: [.55, .7]},
    "show-more": {emojis: ["🏪", "🛒", "✨"], count: 7, speed: [85, 155], size: [14, 20], gravity: 240, lifetime: [580, 820], opacity: [.52, .67]},
    "planned-selection": {emojis: ["✓", "🛒", "🥕"], count: 3, speed: [45, 85], size: [13, 17], gravity: 190, lifetime: [480, 680], opacity: [.52, .67]},
    "remove-purchase": {emojis: ["🧾", "✨"], count: 3, speed: [45, 85], size: [13, 17], gravity: 210, lifetime: [480, 680], opacity: [.5, .65]},
  };

  const canvas = document.createElement("canvas");
  canvas.className = "nutricart-food-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const context = canvas.getContext("2d");
  if (!context) {
    canvas.remove();
    return;
  }

  const particles = [];
  let viewportWidth = window.innerWidth;
  let viewportHeight = window.innerHeight;
  let animationFrame = 0;
  let trailFrame = 0;
  let pendingTrail = null;
  let lastFrameTime = 0;
  let lastTrailTime = 0;
  let lastClickTime = 0;
  let lastTrailX = -100;
  let lastTrailY = -100;

  function setting(key) {
    return window.NutriCartSettings?.getSetting(key);
  }

  function effectsAllowed(kind) {
    if (document.hidden || reducedMotion.matches || setting("cursorEffects") === false) return false;
    return kind === "trail" ? setting("cursorTrail") !== false : setting("clickEffects") !== false;
  }

  function clearParticles() {
    particles.length = 0;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (trailFrame) cancelAnimationFrame(trailFrame);
    animationFrame = 0; lastFrameTime = 0;
    trailFrame = 0; pendingTrail = null;
    lastTrailTime = 0; lastClickTime = 0;
    lastTrailX = -100; lastTrailY = -100;
    context.clearRect(0, 0, viewportWidth, viewportHeight);
  }

  function randomBetween(minimum, maximum) {
    return minimum + (Math.random() * (maximum - minimum));
  }

  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function resizeCanvas() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    canvas.width = Math.round(viewportWidth * pixelRatio);
    canvas.height = Math.round(viewportHeight * pixelRatio);
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  class Particle {
    constructor({kind, emoji, x, y, velocityX, velocityY, size, lifetime, rotationSpeed, gravity = 245, opacity = [.5, .65]}) {
      this.kind = kind;
      this.emoji = emoji;
      this.x = x;
      this.y = y;
      this.velocityX = velocityX;
      this.velocityY = velocityY;
      this.size = size;
      this.lifetime = lifetime;
      this.rotation = randomBetween(-.35, .35);
      this.rotationSpeed = rotationSpeed;
      this.gravity = gravity;
      this.age = 0;
      this.opacity = randomBetween(opacity[0], opacity[1]);
    }

    update(deltaSeconds) {
      this.age += deltaSeconds * 1000;
      this.velocityY += this.gravity * deltaSeconds;
      this.x += this.velocityX * deltaSeconds;
      this.y += this.velocityY * deltaSeconds;
      this.rotation += this.rotationSpeed * deltaSeconds;
      return this.age < this.lifetime;
    }

    draw(ctx) {
      const progress = Math.min(this.age / this.lifetime, 1);
      const fade = 1 - Math.pow(progress, 1.7);
      const scale = progress > .68 ? 1 - ((progress - .68) * .75) : 1;
      ctx.save();
      ctx.globalAlpha = this.opacity * fade;
      ctx.translate(this.x, this.y);
      ctx.rotate(this.rotation);
      ctx.scale(scale, scale);
      ctx.font = `${this.size}px ${emojiFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.emoji, 0, 0);
      ctx.restore();
    }
  }

  function addParticle(settings, kind) {
    if (particles.length >= MAX_PARTICLES) return;
    const kindLimit = kind === "trail" ? MAX_TRAIL_PARTICLES : MAX_CLICK_PARTICLES;
    if (particles.reduce((count, particle) => count + (particle.kind === kind ? 1 : 0), 0) >= kindLimit) return;
    particles.push(new Particle({...settings, kind}));
  }

  function personalityAt(target) {
    if (target?.closest("#meal-plan-view")) return "meal";
    if (target?.closest("#shopping-budget-view")) return "budget";
    if (target?.closest("#snap-view")) return "snap";
    return "planner";
  }

  function trailEmojisAt(target) {
    const contextTarget = target?.closest("[data-cursor-context]");
    const contextPreset = contextTarget && CURSOR_CONTEXT_PRESETS[contextTarget.dataset.cursorContext];
    if (contextPreset) return contextPreset;
    const effectTarget = target?.closest("[data-cursor-effect]");
    const hoverPreset = effectTarget && EFFECT_PRESETS[effectTarget.dataset.cursorEffect];
    if (hoverPreset) return hoverPreset.emojis;
    return TRAIL_PRESETS[personalityAt(target)] || TRAIL_PRESETS.planner;
  }

  function startAnimation() {
    if (!animationFrame) animationFrame = requestAnimationFrame(animate);
  }

  function spawnIngredient(x, y, emojis) {
    addParticle({
        emoji: randomItem(emojis),
        x: x + randomBetween(-4, 4),
        y: y + randomBetween(-3, 3),
        velocityX: randomBetween(-34, 34),
        velocityY: randomBetween(-115, -72),
        size: randomBetween(15, 22),
        lifetime: randomBetween(600, 950),
        rotationSpeed: randomBetween(-2.1, 2.1),
        gravity: 245,
        opacity: [.5, .6],
      }, "trail");
    startAnimation();
  }

  function spawnEffect(x, y, presetName = "default") {
    const preset = EFFECT_PRESETS[presetName] || EFFECT_PRESETS.default;
    for (let index = 0; index < Math.min(preset.count, MAX_CLICK_BURST); index += 1) {
      const angle = randomBetween(0, Math.PI * 2);
      const speed = randomBetween(preset.speed[0], preset.speed[1]);
      addParticle({
        emoji: randomItem(preset.emojis),
        x,
        y,
        velocityX: Math.cos(angle) * speed,
        velocityY: (Math.sin(angle) * speed) - 38,
        size: randomBetween(preset.size[0], preset.size[1]) + CLICK_SIZE_BONUS,
        lifetime: randomBetween(preset.lifetime[0], preset.lifetime[1]),
        rotationSpeed: randomBetween(-3.3, 3.3),
        gravity: preset.gravity,
        opacity: preset.opacity,
      }, "click");
    }
    startAnimation();
  }

  function animate(timestamp) {
    const deltaSeconds = Math.min((timestamp - (lastFrameTime || timestamp)) / 1000, .034);
    lastFrameTime = timestamp;
    context.clearRect(0, 0, viewportWidth, viewportHeight);
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      if (!particles[index].update(deltaSeconds)) particles.splice(index, 1);
      else particles[index].draw(context);
    }
    if (particles.length) animationFrame = requestAnimationFrame(animate);
    else {
      animationFrame = 0;
      lastFrameTime = 0;
    }
  }

  function flushTrail() {
    trailFrame = 0;
    const trail = pendingTrail;
    pendingTrail = null;
    if (!trail || !effectsAllowed("trail")) return;
    const now = performance.now();
    const distance = Math.hypot(trail.x - lastTrailX, trail.y - lastTrailY);
    if (now - lastTrailTime < TRAIL_INTERVAL_MS || distance < MIN_TRAIL_DISTANCE) return;
    lastTrailTime = now;
    lastTrailX = trail.x;
    lastTrailY = trail.y;
    spawnIngredient(trail.x, trail.y, trailEmojisAt(trail.target));
  }

  document.addEventListener("pointermove", event => {
    if (!effectsAllowed("trail")) return;
    if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    pendingTrail = {x: event.clientX, y: event.clientY, target: event.target};
    if (!trailFrame) trailFrame = requestAnimationFrame(flushTrail);
  }, {passive: true});

  document.addEventListener("pointerdown", event => {
    if (!effectsAllowed("click")) return;
    if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const now = performance.now();
    if (now - lastClickTime < CLICK_INTERVAL_MS) return;
    lastClickTime = now;
    const effectTarget = event.target.closest("[data-cursor-effect]");
    const presetName = effectTarget?.dataset.cursorEffect || "default";
    if (presetName === "planned-selection") return;
    spawnEffect(event.clientX, event.clientY, presetName);
  }, {passive: true});

  document.addEventListener("change", event => {
    if (!effectsAllowed("click")) return;
    const select = event.target.closest('[data-cursor-effect="planned-selection"]');
    if (!select || !select.value || select.value === "other") return;
    const bounds = select.getBoundingClientRect();
    spawnEffect(bounds.left + (bounds.width / 2), bounds.top + (bounds.height / 2), "planned-selection");
  });

  window.addEventListener("resize", resizeCanvas, {passive: true});
  document.addEventListener("nutricart:settings-changed", event => {
    if (["cursorEffects", "cursorTrail", "clickEffects", "reset"].includes(event.detail?.key) &&
        (!effectsAllowed("trail") || !effectsAllowed("click"))) clearParticles();
  });
  reducedMotion.addEventListener?.("change", () => { if (reducedMotion.matches) clearParticles(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearParticles(); });
  resizeCanvas();
})();
