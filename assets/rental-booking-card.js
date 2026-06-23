import { Component } from '@theme/component';
import { fetchConfig, debounce } from '@theme/utilities';
import { CartAddEvent, CartErrorEvent } from '@theme/events';

const AVAILABILITY_DEBOUNCE_MS = 400;

/** @param {number} startHour @param {number} startMinute @param {number} endHour @param {number} endMinute
 * @returns {string[]} "HH:MM" slots every 30 minutes, inclusive of the end time. */
function thirtyMinuteSlots(startHour, startMinute, endHour, endMinute) {
  const slots = [];
  let h = startHour;
  let m = startMinute;
  while (h < endHour || (h === endHour && m <= endMinute)) {
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    m += 30;
    if (m >= 60) {
      m -= 60;
      h += 1;
    }
  }
  return slots;
}

/** Shop hours: Tuesday-Friday 10:00-17:00, Saturday 9:00-15:30, closed Sunday/Monday.
 * Mirrored in the backend (biseak-rental-app's src/lib/business-hours.ts) —
 * keep both in sync if hours change.
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {string[]} available "HH:MM" pickup slots for that date, or [] if closed. */
function pickupSlotsForDate(dateStr) {
  const day = new Date(`${dateStr}T00:00:00`).getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  if (day >= 2 && day <= 5) return thirtyMinuteSlots(10, 0, 17, 0);
  if (day === 6) return thirtyMinuteSlots(9, 0, 15, 30);
  return [];
}

/** @param {string} time - "HH:MM" */
function formatTimeLabel(time) {
  const [h, m] = time.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

/** @param {number} amount */
function formatMoney(amount) {
  return amount.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '$';
}

/**
 * Lets a shopper pick a bike model's pickup date, number of days, duration
 * package (4h/8h — forced to 8h/day once more than one day is picked),
 * pickup time, checks live availability via the rental app's App Proxy
 * endpoint, then creates a hold and adds the bike to cart in one action.
 *
 * @typedef {object} RentalBookingCardRefs
 * @property {HTMLButtonElement} selectButton
 * @property {HTMLInputElement} dateInput
 * @property {HTMLInputElement} daysInput
 * @property {HTMLElement} packageField
 * @property {HTMLSelectElement} packageSelect
 * @property {HTMLElement} priceSummary
 * @property {HTMLSelectElement} timeInput
 * @property {HTMLElement} status
 * @property {HTMLButtonElement} submitButton
 * @extends Component<RentalBookingCardRefs>
 */
export class RentalBookingCard extends Component {
  requiredRefs = [
    'selectButton',
    'dateInput',
    'daysInput',
    'packageField',
    'packageSelect',
    'priceSummary',
    'timeInput',
    'status',
    'submitButton',
  ];

  /** @type {string} */
  #productGid = '';
  /** @type {{ numericId: number; price: string } | null} */
  #halfDay = null;
  /** @type {{ numericId: number; price: string } | null} */
  #fullDay = null;
  /** @type {{ available: boolean; availableUnits: number; totalUnits: number } | null} */
  #lastAvailability = null;

  connectedCallback() {
    super.connectedCallback();

    const dataScript = this.querySelector('script[type="application/json"]');
    if (dataScript?.textContent) {
      const data = JSON.parse(dataScript.textContent);
      this.#productGid = data.product;
      this.#halfDay = data.halfDay;
      this.#fullDay = data.fullDay;
    }

    this.#checkAvailability = debounce(this.#checkAvailability.bind(this), AVAILABILITY_DEBOUNCE_MS);

    this.refs.selectButton.addEventListener('click', this.#onSelect);
    this.refs.dateInput.addEventListener('change', this.#onDateChange);
    this.refs.daysInput.addEventListener('input', this.#onDaysChange);
    this.refs.packageSelect.addEventListener('change', this.#onInputChange);
    this.refs.timeInput.addEventListener('change', this.#onInputChange);
    this.refs.submitButton.addEventListener('click', this.#onSubmit);

    this.#onDaysChange();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.refs.selectButton.removeEventListener('click', this.#onSelect);
    this.refs.dateInput.removeEventListener('change', this.#onDateChange);
    this.refs.daysInput.removeEventListener('input', this.#onDaysChange);
    this.refs.packageSelect.removeEventListener('change', this.#onInputChange);
    this.refs.timeInput.removeEventListener('change', this.#onInputChange);
    this.refs.submitButton.removeEventListener('click', this.#onSubmit);
  }

  #onSelect = () => {
    this.classList.add('is-expanded');
  };

  /** @returns {number} */
  #days() {
    const value = Number(this.refs.daysInput.value);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  /** @returns {4 | 8} */
  #durationHours() {
    return this.#days() > 1 ? 8 : /** @type {4 | 8} */ (Number(this.refs.packageSelect.value));
  }

  /** A multi-day rental is always priced at the 8h/day rate — there's no
   * separate multi-day price, just N units of the full-day variant. */
  #onDaysChange = () => {
    const days = this.#days();
    const isMultiDay = days > 1;

    this.refs.packageSelect.disabled = isMultiDay;
    this.refs.packageField.classList.toggle('is-grayed-out', isMultiDay);

    if (isMultiDay && this.#fullDay) {
      const total = days * Number(this.#fullDay.price);
      this.refs.priceSummary.textContent = `${days} × ${formatMoney(Number(this.#fullDay.price))} = ${formatMoney(total)}`;
    } else {
      this.refs.priceSummary.textContent = '';
    }

    this.#onInputChange();
  };

  /** Builds an ISO UTC string from the date+time inputs, interpreted in the
   * shopper's local timezone — correct for the overwhelming majority of
   * bookings, which are made by someone local to the shop. */
  #pickupStartIso() {
    const { dateInput, timeInput } = this.refs;
    if (!dateInput.value || !timeInput.value) return null;
    const local = new Date(`${dateInput.value}T${timeInput.value}:00`);
    if (Number.isNaN(local.getTime())) return null;
    return local.toISOString();
  }

  /** Repopulates the time <select> with the slots open on the chosen date —
   * shows a disabled "closed" option on days the shop isn't open at all. */
  #onDateChange = () => {
    const { timeInput } = this.refs;
    const slots = this.refs.dateInput.value ? pickupSlotsForDate(this.refs.dateInput.value) : [];

    timeInput.innerHTML = '';
    if (slots.length === 0) {
      timeInput.append(new Option('Fermé ce jour — choisissez une autre date', '', true, true));
      timeInput.disabled = true;
    } else {
      timeInput.disabled = false;
      timeInput.append(new Option('Choisir une heure', '', true, true));
      for (const slot of slots) {
        timeInput.append(new Option(formatTimeLabel(slot), slot));
      }
    }

    this.#onInputChange();
  };

  #onInputChange = () => {
    this.#lastAvailability = null;
    this.#checkAvailability();
  };

  #checkAvailability = async () => {
    const start = this.#pickupStartIso();
    if (!start) {
      this.#setStatus('');
      this.refs.submitButton.disabled = true;
      return;
    }

    this.#setStatus('Vérification de la disponibilité…');
    this.refs.submitButton.disabled = true;

    try {
      const params = new URLSearchParams({
        model: this.#productGid,
        durationHours: String(this.#durationHours()),
        start,
        days: String(this.#days()),
      });
      const response = await fetch(`/apps/rental/availability?${params}`, { headers: { Accept: 'application/json' } });
      const data = await response.json();

      if (!response.ok) {
        this.#setStatus(data.message || 'Une erreur est survenue.');
        return;
      }

      this.#lastAvailability = data;
      this.refs.submitButton.disabled = !data.available;
      this.#setStatus(
        data.available
          ? `Disponible (${data.availableUnits}/${data.totalUnits})`
          : 'Aucun vélo disponible pour cette période.',
      );
    } catch (error) {
      console.error('Rental availability check failed:', error);
      this.#setStatus('Une erreur est survenue.');
    }
  };

  /** @param {MouseEvent} event */
  #onSubmit = async (event) => {
    event.preventDefault();
    const start = this.#pickupStartIso();
    const durationHours = this.#durationHours();
    const days = this.#days();
    const variant = durationHours === 4 ? this.#halfDay : this.#fullDay;
    if (!start || !variant || !this.#lastAvailability?.available) return;

    this.refs.submitButton.disabled = true;
    this.#setStatus('Réservation en cours…');

    try {
      // No `shop`/`signature` params here — Shopify's App Proxy appends those
      // itself when it forwards this request from the storefront domain to
      // the app, so the client never needs to (and a client-supplied `shop`
      // would just be ignored in favor of the authoritative one anyway).
      const holdResponse = await fetch('/apps/rental/hold', {
        ...fetchConfig('json'),
        body: JSON.stringify({ model: this.#productGid, durationHours, start, days }),
      });
      const hold = await holdResponse.json();

      if (!holdResponse.ok) {
        this.#setStatus(hold.message || 'Ce vélo vient d’être réservé par quelqu’un d’autre. Veuillez réessayer.');
        this.#onInputChange();
        return;
      }

      const cartResponse = await fetch(Theme.routes.cart_add_url, {
        ...fetchConfig('json'),
        body: JSON.stringify({
          items: [
            {
              id: variant.numericId,
              quantity: durationHours === 8 ? days : 1,
              properties: {
                _booking_hold_id: hold.holdId,
                'Date de prise en charge': new Date(start).toLocaleString('fr-CA'),
              },
            },
          ],
        }),
      });
      const cart = await cartResponse.json();

      if (!cartResponse.ok || cart.status) {
        this.dispatchEvent(new CartErrorEvent(this.id, cart.message, cart.description, cart.errors));
        this.#setStatus(cart.message || 'Impossible d’ajouter au panier.');
        return;
      }

      this.#setStatus('Ajouté au panier !');
      this.dispatchEvent(new CartAddEvent(cart, this.id, { source: 'rental-booking-card' }));
    } catch (error) {
      console.error('Rental hold/add-to-cart failed:', error);
      this.#setStatus('Une erreur est survenue.');
    } finally {
      this.refs.submitButton.disabled = false;
    }
  };

  /** @param {string} message */
  #setStatus(message) {
    this.refs.status.textContent = message;
  }
}

if (!customElements.get('rental-booking-card')) {
  customElements.define('rental-booking-card', RentalBookingCard);
}
