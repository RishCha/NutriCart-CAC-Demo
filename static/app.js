(() => {
  // Event contracts:
  //   Listens: 'nutricart:settings-changed' (for snapRadius and reset actions)
  const locationButton = document.querySelector("#location-button");
  const addressForm = document.querySelector("#address-form");
  const addressInput = document.querySelector("#address");
  const addressButton = document.querySelector("#address-button");
  const detectedLocation = document.querySelector("#detected-location");
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
  const policy = JSON.parse(document.querySelector("#retailer-policy")?.textContent || "{}");
  const filterInputs = [...document.querySelectorAll('input[name="retailer_filter"]')];
  const countLabel = document.querySelector("#retailer-count");
  const guidance = document.createElement("section");
  guidance.className = "store-planning-guidance";
  guidance.setAttribute("aria-label", "Grocery planning suitability");
  const guidanceTitle = document.createElement("h4");
  const guidanceText = document.createElement("p");
  const findGroceryButton = document.createElement("button");
  findGroceryButton.type = "button";
  findGroceryButton.className = "secondary";
  findGroceryButton.textContent = "Find a Grocery Store";
  const acknowledgeButton = document.createElement("button");
  acknowledgeButton.type = "button";
  acknowledgeButton.className = "secondary";
  acknowledgeButton.textContent = "Use an illustrative plan";
  guidance.append(guidanceTitle, guidanceText, findGroceryButton, acknowledgeButton);
  let retailerFilter = "suitable";
  let selectedStore = null;
  window.NutriCartStore = {
    get: () => selectedStore ? {...selectedStore} : null,
    displayName: store => storeDisplayName(store),
    suitability: store => storeSuitability(store),
    planningAllowed: store => planningAllowed(store),
    findGroceryStore: () => findGroceryStore(),
    reviewSelection: () => reviewSelection(),
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
  window.NutriCartLocation = {get: () => planningLocation ? {...planningLocation} : null};

  function publishLocation(location) {
    planningLocation = location ? {...location} : null;
    const label = [location?.locality, location?.region].filter(Boolean).join(", ");
    document.querySelector("#snap-planning-location").textContent = label;
    detectedLocation.hidden = !label;
    updatePlanningTransition();
    document.dispatchEvent(new CustomEvent("nutricart:location-changed", {detail: {location: planningLocation}}));
  }

  function beginLocationChange() {
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
    buildButton.remove();
    guidance.remove();
    if (ready) {
      const category = storeSuitability(selectedStore).category;
      if (category !== "full") {
        guidanceTitle.textContent = category === "unknown" ? "Grocery selection unknown" : "Limited grocery selection";
        guidanceText.textContent = category === "unknown"
          ? "This retailer's grocery assortment is unknown. Store-specific inventory is not available."
          : "This retailer accepts SNAP. Availability for a full grocery plan has not been verified.";
        acknowledgeButton.hidden = category !== "unknown" || selectedStore.illustrative_plan_acknowledged === true;
        selectedCard.append(guidance);
      }
      if (planningAllowed(selectedStore)) selectedCard.append(buildButton);
    }
    locationButton.classList.toggle("primary", !ready);
    locationButton.classList.toggle("secondary", ready);
  }

  function findGroceryStore() {
    retailerFilter = "suitable";
    filterInputs.forEach(input => { input.checked = input.value === retailerFilter; });
    renderRetailers();
    document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view: "snap"}}));
    const heading = document.querySelector("#results-title");
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
  function reviewSelection() {
    retailerFilter = "all";
    filterInputs.forEach(input => { input.checked = input.value === retailerFilter; });
    renderRetailers();
    while (selectedStore && !resultsContainer.querySelector(".store-card.is-selected") && !showMoreButton.hidden) showNextPage();
    document.dispatchEvent(new CustomEvent("nutricart:navigate", {detail: {view: "snap"}}));
  }
  findGroceryButton.addEventListener("click", findGroceryStore);
  acknowledgeButton.addEventListener("click", () => {
    if (!selectedStore || storeSuitability(selectedStore).category !== "unknown") return;
    publishStore({...selectedStore, illustrative_plan_acknowledged: true});
    updatePlanningTransition();
    buildButton.focus({preventScroll: true});
  });

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

  function normalizedName(value) {
    let source = String(value || "").replace(/\s+/g, " ").trim();
    if (!source || !/[a-z]/i.test(source) || /^(snap-authorized retailer|snap retailer|store name unavailable)$/i.test(source)) return null;
    const match = source.match(/^(.+?\S)\s+#\s*([a-z0-9-]+)(?:\s+\2)*$/i) || source.match(/^(.+?\S)\s+(\d{3,}[a-z]?)(?:\s+\2)*$/i);
    if (match && /[a-z]/i.test(match[1])) source = match[1].trim();
    if (source === source.toLowerCase() || source === source.toUpperCase()) {
      source = source.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
      ["CVS", "IGA", "USA"].forEach(acronym => {
        source = source.replace(new RegExp(`\\b${acronym[0]}${acronym.slice(1).toLowerCase()}\\b`, "g"), acronym);
      });
    }
    return source;
  }
  function normalizedAddress(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/).map(word => policy.address_aliases?.[word] || word).join(" ");
  }
  function storeDisplayName(store) {
    for (const field of ["store_name", "source_name", "display_name", "name"]) {
      const name = normalizedName(store?.[field]);
      if (name) return name;
    }
    const id = value => String(value || "").trim().replace(/\.0$/, "");
    const candidates = (policy.identities || []).filter(entry => {
      if (!id(store?.record_id) || id(store.record_id) !== id(entry.record_id)) return false;
      if (!["street_address", "city", "zip_code"].every(key => store[key] && entry[key]) || !(store.state || store.region)) return false;
      if (!["street_address", "additional_address", "city"].every(key => normalizedAddress(store[key]) === normalizedAddress(entry[key]))) return false;
      if (normalizedAddress(store.state || store.region) !== normalizedAddress(entry.state)) return false;
      return /^\d{5}(?:-\d{4})?$/.test(String(store.zip_code)) && String(store.zip_code).slice(0, 5) === String(entry.zip_code).slice(0, 5)
        && normalizedName(entry.display_name) && entry.source_url?.startsWith("https://") && entry.verification_date && entry.source_type;
    });
    return candidates.length === 1 ? candidates[0].display_name : "Store name unavailable";
  }
  function storeSuitability(store) {
    const value = String(store?.store_type || "").replaceAll("\u2013", "-").replaceAll("\u2019", "'").toLowerCase().replace(/\s+/g, " ").trim();
    for (const [category, definition] of Object.entries(policy.categories || {})) {
      if (value && definition.types.some(type => type.toLowerCase() === value)) return {category, label: definition.label};
    }
    return {category: "unknown", label: "Unknown assortment"};
  }
  function planningAllowed(store) {
    if (!store) return false;
    const category = storeSuitability(store).category;
    return category === "full" || (category === "unknown" && store.illustrative_plan_acknowledged === true);
  }
  function storeKey(store) {
    return JSON.stringify([store?.record_id, store?.street_address, store?.city, store?.state || store?.region]);
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
    radio.checked = selectedStore !== null && storeKey(store) === storeKey(selectedStore);
    card.classList.toggle("is-selected", radio.checked);
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
        street_address: store.street_address || "",
        additional_address: store.additional_address || "",
        zip_code: store.zip_code || "",
        store_type: store.store_type || "",
        name_resolution: store.name_resolution || null,
        planning_suitability: storeSuitability(store),
      });
      resultsContainer.querySelectorAll(".store-card").forEach(row => row.classList.toggle("is-selected", row.querySelector("input").checked));
      updatePlanningTransition();
    });
    if (displayName === "Store name unavailable") {
      const supporting = document.createElement("p");
      supporting.textContent = "SNAP-authorized retailer";
      card.append(supporting);
    }
    const suitability = document.createElement("p");
    suitability.className = "store-suitability";
    suitability.textContent = storeSuitability(store).label;
    card.append(suitability);
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

  function filteredRetailers() {
    return retailerFilter === "all" ? retailers : retailers.filter(store => storeSuitability(store).category === "full");
  }
  function updateRetailerCount() {
    const filtered = filteredRetailers();
    const shown = Math.min(visibleCount, filtered.length);
    const total = retailers.length;
    const eligible = retailers.filter(store => storeSuitability(store).category === "full").length;
    countLabel.dataset.displayedCount = String(shown);
    countLabel.dataset.eligibleCount = String(eligible);
    countLabel.dataset.totalCount = String(total);
    document.querySelector("#all-retailers-help").hidden = retailerFilter !== "all";
    if (retailerFilter === "all") {
      countLabel.textContent = shown < total
        ? `Showing ${shown} of ${total} SNAP retailers`
        : `Showing all ${total} SNAP retailer${total === 1 ? "" : "s"}`;
    } else {
      const quantity = shown < filtered.length ? `${shown} of ${filtered.length}` : String(shown);
      countLabel.textContent = `Showing ${quantity} grocery store${filtered.length === 1 ? "" : "s"} \u00b7 ${total} SNAP retailer${total === 1 ? "" : "s"} nearby`;
      if (!filtered.length && total) countLabel.textContent = `No grocery planning stores found \u00b7 ${total} SNAP retailer${total === 1 ? "" : "s"} nearby. Try a larger radius or view all SNAP retailers.`;
    }
    showMoreButton.setAttribute("aria-label", `Show more ${retailerFilter === "all" ? "SNAP retailers" : "grocery planning stores"}, ${shown} of ${filtered.length} shown`);
  }
  function renderRetailers() {
    visibleCount = 0;
    resultsContainer.replaceChildren();
    showNextPage();
    updatePlanningTransition();
  }
  function showNextPage() {
    const scrollY = window.scrollY;
    const filtered = filteredRetailers();
    const nextCount = Math.min(visibleCount + 10, filtered.length);
    filtered.slice(visibleCount, nextCount).forEach(store => resultsContainer.append(renderStore(store, retailers.indexOf(store))));
    visibleCount = nextCount;
    showMoreButton.hidden = visibleCount >= filtered.length;
    updateRetailerCount();
    updatePlanningTransition();
    if (visibleCount > 10) window.scrollTo({top: scrollY, behavior: "instant"});
  }
  filterInputs.forEach(input => input.addEventListener("change", () => {
    if (!input.checked) return;
    retailerFilter = input.value;
    renderRetailers();
  }));

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
      retailers = Array.isArray(data.retailers) ? data.retailers : [];
      visibleCount = 0;
      resultsContainer.replaceChildren();
      resultsSection.hidden = false;
      status.textContent = retailers.length
        ? `${retailers.length} SNAP-authorized retailer${retailers.length === 1 ? "" : "s"} found within ${formatRadius(radiusForSearch)} miles.`
        : `No SNAP-authorized retailers found within ${formatRadius(radiusForSearch)} miles. Try a wider search distance.`;
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
        const latitude = position?.coords?.latitude;
        const longitude = position?.coords?.longitude;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
            || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          status.textContent = "Your current location could not be determined. You can enter an address instead.";
          setSearchLoading(false);
          return;
        }
        currentLocation = {latitude, longitude};
        // Keep coordinates only in temporary search state. This is a neutral
        // display marker in the existing coarse context, not a resolved locality.
        publishLocation({locality: "Current location", region: ""});
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
  document.addEventListener("nutricart:trip-reset", () => {
    locationRequestId += 1;
    searchRequestId += 1;
    activeSearchController?.abort();
    activeSearchController = null;
    publishStore(null); // The address, resolved location, radius and raw results stay available.
    retailerFilter = "suitable";
    filterInputs.forEach(input => { input.checked = input.value === retailerFilter; });
    setSearchLoading(false);
    renderRetailers();
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
    if (!planningAllowed(selectedStore) || !planningLocation || searchInProgress) return;
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
