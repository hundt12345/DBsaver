const form = document.querySelector('#searchForm');
const fromInput = document.querySelector('#fromInput');
const toInput = document.querySelector('#toInput');
const dateInput = document.querySelector('#dateInput');
const swapButton = document.querySelector('#swapButton');
const searchButton = document.querySelector('#searchButton');
const formError = document.querySelector('#formError');
const resultsElement = document.querySelector('#results');

const selections = { from: null, to: null };
const suggestions = {
  from: {
    input: fromInput,
    list: document.querySelector('#fromOptions'),
    timer: null,
    controller: null,
    stations: [],
    activeIndex: -1,
    fallback: false,
  },
  to: {
    input: toInput,
    list: document.querySelector('#toOptions'),
    timer: null,
    controller: null,
    stations: [],
    activeIndex: -1,
    fallback: false,
  },
};

const arrowIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 12h14m0 0-5.5-5.5M18.5 12 13 17.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const stationIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 20h10M8.5 16l-2 4m9-4 2 4M7 4.5h10a2 2 0 0 1 2 2v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 8h8M8.5 13h.01M15.5 13h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function toLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const today = toLocalDate(new Date());
const suggestedDay = new Date();
suggestedDay.setDate(suggestedDay.getDate() + 7);
dateInput.min = today;
dateInput.value = toLocalDate(suggestedDay);

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearFormError() {
  formError.textContent = '';
  formError.hidden = true;
}

function closeSuggestions(which) {
  const context = suggestions[which];
  context.list.hidden = true;
  context.input.setAttribute('aria-expanded', 'false');
  context.input.removeAttribute('aria-activedescendant');
  context.activeIndex = -1;
}

function openSuggestions(which) {
  const context = suggestions[which];
  context.list.hidden = false;
  context.input.setAttribute('aria-expanded', 'true');
}

function showSuggestionMessage(which, message) {
  const context = suggestions[which];
  context.stations = [];
  context.activeIndex = -1;
  context.list.replaceChildren();
  const notice = document.createElement('div');
  notice.className = 'suggestion-message';
  notice.textContent = message;
  notice.setAttribute('role', 'status');
  context.list.append(notice);
  openSuggestions(which);
}

function chooseStation(which, station) {
  selections[which] = station;
  suggestions[which].input.value = station.name;
  suggestions[which].stations = [];
  closeSuggestions(which);
  clearFormError();
}

function activateSuggestion(which, requestedIndex) {
  const context = suggestions[which];
  if (context.stations.length === 0) return;

  context.activeIndex = Math.max(0, Math.min(requestedIndex, context.stations.length - 1));
  const options = context.list.querySelectorAll('.suggestion-option');
  options.forEach((option, index) => {
    const isActive = index === context.activeIndex;
    option.setAttribute('aria-selected', String(isActive));
    if (isActive) {
      context.input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  });
}

function renderStationSuggestions(which, stations) {
  const context = suggestions[which];
  context.stations = stations;
  context.activeIndex = -1;
  context.list.replaceChildren();

  if (stations.length === 0) {
    showSuggestionMessage(which, context.fallback
      ? 'Im lokalen Stationsindex wurden keine passenden Bahnhöfe gefunden.'
      : 'Keine passenden Bahnhöfe gefunden.');
    return;
  }

  if (context.fallback) {
    const note = document.createElement('div');
    note.className = 'suggestion-message';
    note.textContent = 'Offline-Bahnhofsliste · Datenstand kann abweichen';
    context.list.append(note);
  }

  stations.forEach((station, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `${which}Option${index}`;
    option.className = 'suggestion-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');

    const icon = document.createElement('span');
    icon.className = 'suggestion-icon';
    icon.innerHTML = stationIcon;

    const name = document.createElement('span');
    name.className = 'suggestion-name';
    name.textContent = station.name;

    const meta = document.createElement('span');
    meta.className = 'suggestion-meta';
    meta.textContent = context.fallback ? 'Offline' : 'Bahnhof';

    option.append(icon, name, meta);
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('click', () => chooseStation(which, station));
    context.list.append(option);
  });

  openSuggestions(which);
}

async function fetchStationSuggestions(which, query) {
  const context = suggestions[which];
  context.controller?.abort();
  const controller = new AbortController();
  context.controller = controller;

  try {
    const response = await fetch(`/api/stations?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Bahnhofssuche fehlgeschlagen.');
    if (context.input.value.trim() !== query) return;
    context.fallback = Boolean(payload.fallback);
    renderStationSuggestions(which, Array.isArray(payload.stations) ? payload.stations : []);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (context.input.value.trim() !== query) return;
    showSuggestionMessage(which, 'Bahnhofssuche gerade nicht verfügbar. Bitte erneut versuchen.');
  }
}

function queueStationSearch(which) {
  const context = suggestions[which];
  const query = context.input.value.trim();
  selections[which] = null;
  clearFormError();
  context.controller?.abort();
  window.clearTimeout(context.timer);

  if (query.length < 2) {
    context.stations = [];
    closeSuggestions(which);
    return;
  }

  showSuggestionMessage(which, 'Bahnhöfe werden gesucht …');
  context.timer = window.setTimeout(() => fetchStationSuggestions(which, query), 280);
}

for (const which of ['from', 'to']) {
  const context = suggestions[which];
  context.input.addEventListener('input', () => queueStationSearch(which));
  context.input.addEventListener('focus', () => {
    if (context.stations.length > 0) openSuggestions(which);
  });
  context.input.addEventListener('blur', () => {
    window.setTimeout(() => closeSuggestions(which), 130);
  });
  context.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSuggestions(which);
      return;
    }

    if (event.key === 'ArrowDown' && context.stations.length > 0) {
      event.preventDefault();
      activateSuggestion(which, context.activeIndex + 1);
    } else if (event.key === 'ArrowUp' && context.stations.length > 0) {
      event.preventDefault();
      activateSuggestion(which, context.activeIndex < 0 ? context.stations.length - 1 : context.activeIndex - 1);
    } else if (event.key === 'Enter' && !context.list.hidden) {
      const index = context.activeIndex >= 0 ? context.activeIndex : context.stations.length === 1 ? 0 : -1;
      if (index >= 0) {
        event.preventDefault();
        chooseStation(which, context.stations[index]);
      }
    }
  });
}

swapButton.addEventListener('click', () => {
  const currentFrom = selections.from;
  const previousFromValue = fromInput.value;
  const previousToValue = toInput.value;
  selections.from = selections.to;
  selections.to = currentFrom;
  fromInput.value = selections.from?.name || previousToValue;
  toInput.value = selections.to?.name || previousFromValue;
  closeSuggestions('from');
  closeSuggestions('to');
  clearFormError();
});

function formatTime(value) {
  if (!value) return '–:–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–:–';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

function formatPrice(amount, currency = 'EUR') {
  try {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${escapeHtml(currency)}`;
  }
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return 'Dauer n. v.';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} Min.`;
  if (rest === 0) return `${hours} Std.`;
  return `${hours} Std. ${rest} Min.`;
}

function formatChanges(changes) {
  if (changes === 0) return 'Direkt';
  if (!Number.isFinite(changes)) return 'Verbindung';
  return `${changes} ${changes === 1 ? 'Umstieg' : 'Umstiege'}`;
}

function renderLoading() {
  resultsElement.innerHTML = '<div class="results-loading"><span class="loading-spinner" aria-hidden="true"></span><span>Wir fragen den Tagesbestpreis bei bahn.de ab und vergleichen die gefundenen Verbindungen …</span></div>';
}

function renderError(message) {
  resultsElement.innerHTML = `
    <div class="result-error">
      <p class="result-message-title">Live-Auskunft gerade nicht verfügbar</p>
      <p class="result-message-copy">${escapeHtml(message)}</p>
    </div>`;
}

function renderEmpty(data) {
  const link = data.bookingUrl
    ? `<a class="result-retry-link" href="${escapeHtml(data.bookingUrl)}" target="_blank" rel="noopener noreferrer">Strecke direkt bei bahn.de prüfen ↗</a>`
    : '';
  resultsElement.innerHTML = `
    <div class="result-empty">
      <p class="result-message-title">Für diesen Tag wurde kein Preis gefunden.</p>
      <p class="result-message-copy">Es liegen gerade keine bepreisten Verbindungen vor. Prüfe die Strecke direkt bei bahn.de oder wähle einen anderen Reisetag.</p>
      ${link}
    </div>`;
}

function renderOfferRow(offer) {
  const times = `${formatTime(offer.departure)} <span aria-hidden="true">→</span> ${formatTime(offer.arrival)}`;
  const details = [formatDuration(offer.durationMinutes), formatChanges(offer.changes), ...(offer.trains || [])]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="offer-row">
      <span class="offer-row-times">${times}</span>
      <span class="offer-row-meta">${escapeHtml(details)}${offer.partialFare ? ' · Teilpreis' : ''}</span>
      <span class="offer-row-price">${formatPrice(offer.price, offer.currency)}</span>
    </div>`;
}

function renderResults(data, selection, date) {
  const offers = Array.isArray(data.results) ? data.results : [];
  if (offers.length === 0) {
    renderEmpty(data);
    return;
  }

  const best = offers[0];
  const travelDate = formatDate(data.date || date);
  const departure = formatTime(best.departure);
  const arrival = formatTime(best.arrival);
  const origin = best.from || selection.from.name;
  const destination = best.to || selection.to.name;
  const trains = Array.isArray(best.trains) ? best.trains.filter(Boolean) : [];
  const trainLabel = trains.length > 0 ? trains.join(' · ') : 'Verbindung am gewählten Reisetag';
  const otherOffers = offers.slice(1, 5);
  const queriedAt = data.queriedAt ? new Date(data.queriedAt) : null;
  const queriedLabel = queriedAt && !Number.isNaN(queriedAt.getTime())
    ? `Zuletzt live abgefragt um ${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(queriedAt)} Uhr.`
    : 'Live abgefragt bei bahn.de.';

  resultsElement.innerHTML = `
    <div class="result-heading-line">
      <div>
        <p class="result-eyebrow">TAGESBESTPREIS</p>
        <h3>Günstigste Verbindung gefunden</h3>
      </div>
      <span class="fresh-tag"><span aria-hidden="true"></span> Live-Abfrage</span>
    </div>

    <article class="best-offer" aria-label="Günstigste Verbindung">
      <div class="best-offer-top">
        <div class="best-price">
          <span class="price-label">ab</span>
          <strong class="price-amount">${formatPrice(best.price, best.currency)}</strong>
          <span class="price-caption">pro Person · 2. Klasse<br>einfache Fahrt</span>
        </div>
        <div class="trip-overview">
          <div class="trip-date-label">${escapeHtml(travelDate)}</div>
          <div class="trip-timeline">
            <div class="trip-endpoint">
              <time class="trip-time">${escapeHtml(departure)}</time>
              <span class="trip-station" title="${escapeHtml(origin)}">${escapeHtml(origin)}</span>
            </div>
            <div class="trip-middle">
              <span>${escapeHtml(formatDuration(best.durationMinutes))}</span>
              <span class="route-dashes" aria-hidden="true"></span>
              <span class="trip-change">${escapeHtml(formatChanges(best.changes))}</span>
            </div>
            <div class="trip-endpoint trip-endpoint--arrival">
              <time class="trip-time">${escapeHtml(arrival)}</time>
              <span class="trip-station" title="${escapeHtml(destination)}">${escapeHtml(destination)}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="best-offer-bottom">
        <span class="trip-services"><strong>${escapeHtml(trainLabel)}</strong></span>
        ${best.partialFare ? '<span class="partial-fare">Teilpreis</span>' : ''}
        <a class="bahn-link" href="${escapeHtml(data.bookingUrl || 'https://www.bahn.de/') }" target="_blank" rel="noopener noreferrer">Auf bahn.de prüfen ${arrowIcon}</a>
      </div>
    </article>

    ${otherOffers.length > 0 ? `
      <section class="more-offers" aria-label="Weitere günstige Abfahrten">
        <h4>Weitere günstige Verbindungen</h4>
        <div class="offer-list">${otherOffers.map(renderOfferRow).join('')}</div>
      </section>` : ''}

    <p class="queried-at">${escapeHtml(queriedLabel)} Der endgültige Preis kann sich ändern; maßgeblich ist das Angebot auf bahn.de.</p>`;
}

function validateSearch() {
  const from = selections.from;
  const to = selections.to;

  if (!from) {
    showFormError('Bitte wähle einen Abfahrtsbahnhof aus den Vorschlägen aus.');
    fromInput.focus();
    return null;
  }
  if (!to) {
    showFormError('Bitte wähle einen Zielbahnhof aus den Vorschlägen aus.');
    toInput.focus();
    return null;
  }
  if (from.id === to.id) {
    showFormError('Start und Ziel müssen unterschiedlich sein.');
    toInput.focus();
    return null;
  }
  if (!dateInput.value || dateInput.value < today) {
    showFormError('Bitte wähle einen gültigen Reisetag ab heute.');
    dateInput.focus();
    return null;
  }

  return { from, to, date: dateInput.value };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormError();
  closeSuggestions('from');
  closeSuggestions('to');

  const search = validateSearch();
  if (!search) return;

  searchButton.disabled = true;
  searchButton.setAttribute('aria-busy', 'true');
  searchButton.innerHTML = '<span>Preis wird gesucht …</span><span class="loading-spinner" aria-hidden="true"></span>';
  renderLoading();

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        from: search.from,
        to: search.to,
        date: search.date,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Die Preissuche ist fehlgeschlagen.');
    renderResults(payload, search, search.date);
    resultsElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    renderError(error.message || 'Bitte prüfe deine Internetverbindung und versuche es erneut.');
  } finally {
    searchButton.disabled = false;
    searchButton.removeAttribute('aria-busy');
    searchButton.innerHTML = `<span>Günstigsten Preis finden</span>${arrowIcon}`;
  }
});
