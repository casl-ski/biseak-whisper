import { Component } from '@theme/component';
import { fetchConfig, debounce } from '@theme/utilities';
import { CartAddEvent, CartErrorEvent } from '@theme/events';

const AVAILABILITY_DEBOUNCE_MS = 400;
const CALENDAR_RANGE_DAYS = 90;

/** @param {string} time - "HH:MM" */
function formatTimeLabel(time) {
  const [h, m] = time.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

/** @param {number} amount */
function formatMoney(amount) {
  return amount.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '$';
}

/** @param {Date} date @returns {string} "YYYY-MM-DD" (calendar arithmetic only, no timezone conversion) */
function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Product-page bike rental booking widget: number of days, duration package
 * (4h/8h — forced to 8h/day once more than one day is picked), a calendar
 * grid for the pickup date (gray/half-gray/normal days from the rental
 * app's calendar endpoint), and pickup time (options disabled per the same
 * data). Checks live availability via the rental app's App Proxy endpoint,
 * then creates a hold and adds the bike to cart in one action.
 *
 * @typedef {object} RentalBookingWidgetRefs
 * @property {import('./rental-calendar.js').RentalCalendar} calendar
 * @property {HTMLInputElement} daysInput
 * @property {HTMLElement} packageField
 * @property {HTMLSelectElement} packageSelect
 * @property {HTMLElement} priceSummary
 * @property {HTMLSelectElement} timeInput
 * @property {HTMLElement} riderFields
 * @property {HTMLInputElement} nameInput
 * @property {HTMLInputElement} phoneInput
 * @property {HTMLInputElement} weightInput
 * @property {HTMLInputElement} heightFeetInput
 * @property {HTMLInputElement} heightInchesInput
 * @property {HTMLElement} status
 * @property {HTMLButtonElement} submitButton
 * @extends Component<RentalBookingWidgetRefs>
 */
export class RentalBookingWidget extends Component {
  requiredRefs = [
    'calendar',
    'daysInput',
    'packageField',
    'packageSelect',
    'priceSummary',
    'timeInput',
    'riderFields',
    'nameInput',
    'phoneInput',
    'weightInput',
    'heightFeetInput',
    'heightInchesInput',
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

    this.refs.calendar.addEventListener('rentalcalendar:select', this.#onCalendarSelect);
    this.refs.daysInput.addEventListener('input', this.#onDurationChange);
    this.refs.packageSelect.addEventListener('change', this.#onDurationChange);
    this.refs.timeInput.addEventListener('change', this.#onTimeChange);
    this.refs.submitButton.addEventListener('click', this.#onSubmit);

    this.#onDaysChange();
    this.#fetchCalendar();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.refs.calendar.removeEventListener('rentalcalendar:select', this.#onCalendarSelect);
    this.refs.daysInput.removeEventListener('input', this.#onDurationChange);
    this.refs.packageSelect.removeEventListener('change', this.#onDurationChange);
    this.refs.timeInput.removeEventListener('change', this.#onTimeChange);
    this.refs.submitButton.removeEventListener('click', this.#onSubmit);
  }

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

  /** Days-count or package changes can flip the effective duration (4h vs
   * 8h), which changes which slots/days the calendar should gray out. */
  #onDurationChange = () => {
    this.#onDaysChange();
    this.#fetchCalendar();
  };

  /** Builds an ISO UTC string from the selected calendar date + time,
   * interpreted in the shopper's local timezone — correct for the
   * overwhelming majority of bookings, which are made by someone local to
   * the shop. */
  #pickupStartIso() {
    const selectedDate = this.refs.calendar.selectedDate;
    const { timeInput } = this.refs;
    if (!selectedDate || !timeInput.value) return null;
    const local = new Date(`${selectedDate}T${timeInput.value}:00`);
    if (Number.isNaN(local.getTime())) return null;
    return local.toISOString();
  }

  /** Fetches per-day/per-slot availability for the visible calendar window
   * and hands it to the <rental-calendar> element to render. Re-run whenever
   * the effective duration changes, since that's the only thing that
   * affects which slots/days are blocked. */
  #fetchCalendar = async () => {
    if (!this.#productGid) return;
    const from = dateKey(new Date());
    const to = dateKey(new Date(new Date().setDate(new Date().getDate() + CALENDAR_RANGE_DAYS - 1)));

    try {
      const params = new URLSearchParams({
        product: this.#productGid,
        durationHours: String(this.#durationHours()),
        from,
        to,
      });
      const response = await fetch(`/apps/rental/calendar?${params}`, { headers: { Accept: 'application/json' } });
      const data = await response.json();

      if (!response.ok) {
        console.error('Rental calendar fetch failed:', data);
        return;
      }

      this.refs.calendar.setData(data.days, from, to);
      this.#onCalendarSelect();
    } catch (error) {
      console.error('Rental calendar fetch failed:', error);
    }
  };

  /** Repopulates the time <select> from the calendar's per-slot data for the
   * selected day — options for already-booked slots are disabled rather
   * than omitted, so the shopper can see what's blocked. */
  #onCalendarSelect = () => {
    const selectedDate = this.refs.calendar.selectedDate;
    const slots = Object.entries(this.refs.calendar.selectedDaySlots);
    const { timeInput } = this.refs;

    timeInput.innerHTML = '';
    if (!selectedDate || slots.length === 0) {
      timeInput.append(new Option('Choisir une date d’abord', '', true, true));
      timeInput.disabled = true;
    } else {
      timeInput.disabled = false;
      timeInput.append(new Option('Choisir une heure', '', true, true));
      for (const [slot, isFree] of slots) {
        const option = new Option(formatTimeLabel(slot), slot);
        option.disabled = !isFree;
        timeInput.append(option);
      }
    }

    // The time select just got reset to its placeholder — hide the rider
    // fields until a real time is picked again.
    this.refs.riderFields.hidden = true;
    this.#onInputChange();
  };

  /** Reveals the weight/height fields once a real pickup time is picked —
   * asking for them before that point would be premature. */
  #onTimeChange = () => {
    this.refs.riderFields.hidden = !this.refs.timeInput.value;
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
        product: this.#productGid,
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
          : 'Ce vélo n’est pas disponible pour cette période.',
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
      const customerName = this.refs.nameInput.value.trim() || undefined;
      const customerPhone = this.refs.phoneInput.value.trim() || undefined;
      const customerWeightLbs = Number(this.refs.weightInput.value) || undefined;
      const heightFeet = Number(this.refs.heightFeetInput.value) || 0;
      const heightInches = Number(this.refs.heightInchesInput.value) || 0;
      const customerHeightInches = heightFeet || heightInches ? heightFeet * 12 + heightInches : undefined;

      const holdResponse = await fetch('/apps/rental/hold', {
        ...fetchConfig('json'),
        body: JSON.stringify({
          product: this.#productGid,
          durationHours,
          start,
          days,
          customerName,
          customerPhone,
          customerWeightLbs,
          customerHeightInches,
        }),
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
        // The hold succeeded but the cart add didn't — release it now rather
        // than leaving the bike blocked for other customers until the cron
        // sweep expires it up to 15 minutes later.
        fetch(`/apps/rental/hold/${hold.holdId}/cancel`, fetchConfig('json')).catch((error) => {
          console.error('Failed to release orphaned hold:', error);
        });
        return;
      }

      this.#setStatus('Ajouté au panier !');
      this.dispatchEvent(new CartAddEvent(cart, this.id, { source: 'rental-booking-widget' }));
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

if (!customElements.get('rental-booking-widget')) {
  customElements.define('rental-booking-widget', RentalBookingWidget);
}
