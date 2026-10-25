(() => {
  // Event contracts:
  //   Listens: 'nutricart:settings-changed' (for snapRadius and reset actions)
  const locationButton = document.querySelector("#location-button");
  const addressForm = document.querySelector("#address-form");
  const addressInput = document.querySelector("#address");
  const addressButton = document.querySelector("#address-button");
  const detectedLocation = document.querySelector("#detected-location");
  const detectedLocationNote = document.querySelector("#detected-location-note");
  const radiusPresets = [...document.querySelectorAll(".radius-preset")];
  const customRadiusInput = document.querySelector("#custom-radius");
  const applyRadiusButton = document.querySelector("#apply-radius");
  const selectedRadiusText = document.querySelector("#selected-radius");
  const radiusSummary = document.querySelector(".radius-options > summary");
  const radiusMessage = document.querySelector("#radius-message");
  const status = document.querySelector("#status");
  const resultsSection = document.querySelector("#results-section");
  const resultsContainer = document.querySelector("#results");
  const showMoreButton = document.querySelector("#show-more");
  const newLocationButton = document.querySelector("#new-location");
  const buildButton = document.createElement("button");
  buildButton.id = "snap-build-basket";
  buildButton.type = "button";
  buildButton.className = "primary store-build-button";
  buildButton.textContent = "Build My Grocery Plan";
  let selectedStore = null;
  window.NutriCartStore = {
    get: () => selectedStore ? {...selectedStore} : null,
    displayName: store => storeDisplayName(store),
  };
  function publishStore(store) {
    selectedStore = store ? {...store} : null;
    document.dispatchEvent(new CustomEvent("nutricart:store-changed", {detail: {store: selectedStore ? {...selectedStore} : null}}));
  }
  let retailers = [];
  let visibleCount = 0;
  let selectedRadius = 5;
  let searchInProgress = false;
  let locationRequestId = 0;
  let currentLocation = null;
  let activeSearchController = null;
  let searchRequestId = 0;
  let planningLocation = null;
  let addressRevision = 0;
  let locationWarning = "";
  window.NutriCartLocation = {get: () => planningLocation ? {...planningLocation} : null};
  addressInput.addEventListener("input", () => { addressRevision += 1; });

  function publishLocation(location, fromDevice = false) {
    planningLocation = location ? {...location} : null;
    const label = [location?.locality, location?.region].filter(Boolean).join(", ");
    document.querySelector("#snap-planning-location").textContent = label;
    detectedLocation.hidden = !label;
    detectedLocationNote.hidden = !label || !fromDevice;
    updatePlanningTransition();
    document.dispatchEvent(new CustomEvent("nutricart:location-changed", {detail: {location: planningLocation}}));
  }

  function beginLocationChange() {
    locationWarning = "";
    currentLocation = null;
    publishStore(null);
    planningLocation = null;
    buildButton.remove();
    detectedLocation.hidden = true;
    if (activeSearchController) activeSearchController.abort();
    activeSearchController = null;
    searchRequestId += 1;
    document.querySelector("#snap-planning-location").textContent = "";
    retailers = [];
    resultsContainer.replaceChildren();
    resultsSection.hidden = true;
    document.dispatchEvent(new Event("nutricart:location-changing"));
  }

  function updatePlanningTransition() {
    const selectedCard = resultsContainer.querySelector(".store-card.is-selected");
    const ready = Boolean(planningLocation && selectedStore && selectedCard && !resultsSection.hidden && !searchInProgress);
    if (ready) {
      if (buildButton.parentElement !== selectedCard) selectedCard.append(buildButton);
    } else buildButton.remove();
    locationButton.classList.toggle("primary", !ready);
    locationButton.classList.toggle("secondary", ready);
  }

  function formatRadius(value) {
    return Number.isInteger(value) ? String(value) : String(value);
  }

  function selectRadius(value, selectedPreset = null) {
    selectedRadius = value;
    selectedRadiusText.textContent = `Selected radius: ${formatRadius(value)} miles`;
    if (radiusSummary) radiusSummary.textContent = `Search distance: ${formatRadius(value)} miles`;
    radiusPresets.forEach(button => {
      const selected = button === selectedPreset;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    radiusMessage.textContent = value > 50 ? "Large-radius searches may take longer." : "";
  }

  function applyCustomRadius() {
    const value = Number(customRadiusInput.value);
    if (customRadiusInput.value.trim() === "" || !Number.isFinite(value) || value <= 0) {
      radiusMessage.textContent = "Enter a search radius greater than 0 miles.";
      return;
    }
    selectRadius(value);
    refreshCurrentSearch();
  }

  function setSearchLoading(loading, source = null) {
    searchInProgress = loading;
    updatePlanningTransition();
    [locationButton, addressInput, addressButton, newLocationButton]
      .forEach(control => { control.disabled = loading; });
    locationButton.setAttribute("aria-busy", String(loading));
    addressButton.setAttribute("aria-busy", String(loading));
    locationButton.textContent = loading && source === "location" ? "Getting Your Location..." : "Use My Current Location";
    addressButton.textContent = loading && source === "address" ? "Finding Stores..." : "Search by Address";
  }

  async function postJson(url, body, signal = undefined) {
    const response = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The search could not be completed.");
    return data;
  }

  function storeDisplayName(store) {
    // Re-normalize raw names first: saved records may carry an old generic label.
    let source = String(store?.store_name || store?.source_name || store?.display_name || "").replace(/\s+/g, " ").trim();
    if (!source || !/[a-z]/i.test(source) || /^(snap-authorized retailer|snap retailer)$/i.test(source)) return "SNAP retailer";
    const identified = source.match(/^(.+?\S)\s+#\s*([a-z0-9-]+)(?:\s+\2)*$/i);
    if (identified && /[a-z]/i.test(identified[1])) source = identified[1].trim();
    else {
      const numbered = source.match(/^(.+?\S)\s+(\d{3,}[a-z]?)(?:\s+\2)*$/i);
      if (numbered && /[a-z]/i.test(numbered[1])) source = numbered[1].trim();
    }
    if (source === source.toLowerCase() || source === source.toUpperCase()) {
      source = source.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
      ["CVS", "IGA", "USA"].forEach(acronym => {
        source = source.replace(new RegExp(`\\b${acronym[0]}${acronym.slice(1).toLowerCase()}\\b`, "g"), acronym);
      });
    }
    return source;
  }

  function renderStore(store, index) {
    const card = document.createElement("article");
    card.className = "store-card";
    const heading = document.createElement("h3");
    const displayName = storeDisplayName(store);
    heading.textContent = displayName;
    const label = document.createElement("label");
    label.className = "store-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "snap_store";
    radio.value = String(index);
    const title = document.createElement("span");
    title.textContent = heading.textContent;
    radio.setAttribute("aria-label", `Select ${heading.textContent}, ${store.street_address || store.city || ""}`);
    label.append(radio, title);
    heading.replaceChildren(label);
    card.append(heading);
    radio.addEventListener("change", () => {
      if (!radio.checked || searchInProgress) return;
      publishStore({
        record_id: store.record_id ?? null,
        name: displayName,
        source_name: String(store.store_name || "").trim(),
        city: store.city || "",
        region: store.state || "",
      });
      resultsContainer.querySelectorAll(".store-card").forEach(row => row.classList.toggle("is-selected", row.querySelector("input").checked));
      updatePlanningTransition();
    });
    const details = [
      ["Store type", store.store_type || "Not listed"],
      ["Distance", `${Number(store.distance_miles || 0).toFixed(1)} miles`],
      ["Address", [store.street_address, store.additional_address, store.city, [store.state, store.zip_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")],
    ];
    if (store.incentive_program) details.push(["Healthy incentive", store.incentive_program]);
    details.forEach(([label, value]) => {
      const row = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      row.append(strong, document.createTextNode(value || "Not listed"));
      card.append(row);
    });
    card.addEventListener("click", event => {
      if (event.target.closest("button, a, input, label")) return;
      radio.click();
      radio.focus({preventScroll: true});
    });
    return card;
  }

  function showNextPage() {
    const scrollY = window.scrollY;
    const nextCount = Math.min(visibleCount + 10, retailers.length);
    retailers.slice(visibleCount, nextCount).forEach((store, index) => resultsContainer.append(renderStore(store, visibleCount + index)));
    visibleCount = nextCount;
    showMoreButton.hidden = visibleCount >= retailers.length;
    if (visibleCount > 10) window.scrollTo({top: scrollY, behavior: "instant"});
  }

  async function search(latitude, longitude, radiusForSearch) {
    if (activeSearchController) activeSearchController.abort();
    const controller = new AbortController();
    activeSearchController = controller;
    const requestId = ++searchRequestId;
    publishStore(null);
    resultsContainer.replaceChildren();
    resultsSection.hidden = true;
    setSearchLoading(true);
    status.textContent = `Searching within ${formatRadius(radiusForSearch)} miles...`;
    try {
      const data = await postJson("/api/snap-retailers", {latitude, longitude, radius_miles: radiusForSearch}, controller.signal);
      if (requestId !== searchRequestId) return null;
      retailers = data.retailers;
      visibleCount = 0;
      resultsContainer.replaceChildren();
      resultsSection.hidden = false;
      status.textContent = retailers.length
        ? `${retailers.length} SNAP-authorized retailer${retailers.length === 1 ? "" : "s"} found within ${formatRadius(radiusForSearch)} miles.`
        : `No SNAP-authorized retailers found within ${formatRadius(radiusForSearch)} miles. Try a wider search distance.`;
      if (locationWarning) status.textContent += ` ${locationWarning}`;
      showNextPage();
      return status.textContent;
    } catch (error) {
      if (error.name === "AbortError") return null;
      throw error;
    } finally {
      if (requestId === searchRequestId) {
        activeSearchController = null;
        setSearchLoading(false);
      }
    }
  }

  function refreshCurrentSearch() {
    if (!currentLocation) return;
    search(currentLocation.latitude, currentLocation.longitude, selectedRadius)
      .catch(error => { status.textContent = error.message; });
  }

  function requestApproximateAddress(latitude, longitude, requestId) {
    const revision = addressRevision;
    postJson("/api/reverse-geocode", {latitude, longitude})
      .then(match => {
        if (requestId !== locationRequestId) return;
        if (!match.matched_address || !match.planning_location) throw new Error("Unresolved location");
        if (match.matched_address) {
          if (addressRevision === revision) addressInput.value = match.matched_address;
          publishLocation(match.planning_location, true);
        }
      })
      .catch(() => {
        if (requestId === locationRequestId) {
          locationWarning = "Your location name could not be resolved. Please enter an address.";
          status.textContent = locationWarning;
        }
      });
  }

  locationButton.addEventListener("click", () => {
    if (searchInProgress) return;
    status.textContent = "Getting your location...";
    const requestId = ++locationRequestId;
    beginLocationChange();
    addressInput.value = "";
    detectedLocation.hidden = true;
    setSearchLoading(true, "location");
    if (!navigator.geolocation) {
      status.textContent = "Your current location could not be determined. You can enter an address instead.";
      setSearchLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => {
        if (requestId !== locationRequestId) return;
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;
        currentLocation = {latitude, longitude};
        requestApproximateAddress(latitude, longitude, requestId);
        search(latitude, longitude, selectedRadius)
          .catch(error => { status.textContent = error.message; });
      },
      error => {
        if (requestId !== locationRequestId) return;
        const messages = {
          1: "Location permission was not granted. You can enter an address instead.",
          2: "Your current location could not be determined. You can enter an address instead.",
          3: "Location lookup timed out. Try again or enter an address.",
        };
        status.textContent = messages[error.code] || messages[2];
        setSearchLoading(false);
      },
      {enableHighAccuracy: false, timeout: 10000, maximumAge: 300000}
    );
  });

  addressForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (searchInProgress) return;
    const requestId = ++locationRequestId;
    detectedLocation.hidden = true;
    const address = addressInput.value.trim();
    if (!address) { status.textContent = "Please enter a street address."; return; }
    beginLocationChange();
    setSearchLoading(true, "address");
    try {
      status.textContent = "Finding that address…";
      const match = await postJson("/api/geocode", {address});
      if (requestId !== locationRequestId) return;
      publishLocation(match.planning_location);

      currentLocation = {latitude: match.latitude, longitude: match.longitude};
      const resultMessage = await search(match.latitude, match.longitude, selectedRadius);
      if (resultMessage) status.textContent = resultMessage;
    } catch (error) { status.textContent = error.message; setSearchLoading(false); }
  });

  radiusPresets.forEach(button => button.addEventListener("click", () => {
    selectRadius(Number(button.dataset.radius), button);
    refreshCurrentSearch();
  }));
  applyRadiusButton.addEventListener("click", applyCustomRadius);
  showMoreButton.addEventListener("click", showNextPage);
  newLocationButton.addEventListener("click", () => {
    locationRequestId += 1;
    searchRequestId += 1;
    if (activeSearchController) activeSearchController.abort();
    activeSearchController = null;
    beginLocationChange();
    publishLocation(null);
    currentLocation = null;
    detectedLocation.hidden = true;
    retailers = [];
    visibleCount = 0;
    resultsContainer.replaceChildren();
    resultsSection.hidden = true;
    status.textContent = "Choose a new location to search.";
  });
  document.addEventListener("nutricart:account-signed-out", () => {
    locationRequestId += 1;
    searchRequestId += 1;
    if (activeSearchController) activeSearchController.abort();
    activeSearchController = null;
    beginLocationChange();
    publishLocation(null);
    addressInput.value = "";
    status.textContent = "";
  });
  buildButton.addEventListener("click", () => {
    if (!selectedStore || !planningLocation || searchInProgress) return;
    document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view: "planner"}}));
  });
  const header = document.querySelector(".site-header");
  const updateHeaderOffset = () => {
    document.documentElement.style.setProperty("--header-offset", `${Math.ceil(header.getBoundingClientRect().height + 24)}px`);
  };
  new ResizeObserver(updateHeaderOffset).observe(header);
  updateHeaderOffset();
  const initialRadius = Number(window.NutriCartSettings?.getSetting("snapRadius") || 5);
  selectRadius(initialRadius, radiusPresets.find(button => Number(button.dataset.radius) === initialRadius));
  document.addEventListener("nutricart:settings-changed", event => {
    if (!["snapRadius", "reset"].includes(event.detail?.key) || searchInProgress) return;
    const radius = Number(event.detail.settings.snapRadius);
    selectRadius(radius, radiusPresets.find(button => Number(button.dataset.radius) === radius));
  });
})();
