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

/**
 * Lets a shopper pick a bike model's duration package + pickup date/time,
 * checks live availability via the rental app's App Proxy endpoint, then
 * creates a hold and adds the bike to cart in one action.
 *
 * @typedef {object} RentalBookingCardRefs
 * @property {HTMLButtonElement} selectButton
 * @property {HTMLSelectElement} variantSelect
 * @property {HTMLInputElement} dateInput
 * @property {HTMLInputElement} timeInput
 * @property {HTMLElement} status
 * @property {HTMLButtonElement} submitButton
 * @extends Component<RentalBookingCardRefs>
 */
export class RentalBookingCard extends Component {
  requiredRefs = ['selectButton', 'variantSelect', 'dateInput', 'timeInput', 'status', 'submitButton'];

  /** @type {{ id: string; gid: string; title: string }[]} */
  #variants = [];
  /** @type {string} */
  #productGid = '';
  /** @type {{ availableUnits: number } | null} */
  #lastAvailability = null;

  connectedCallback() {
    super.connectedCallback();

    const dataScript = this.querySelector('script[type="application/json"]');
    if (dataScript?.textContent) {
      const data = JSON.parse(dataScript.textContent);
      this.#productGid = data.product;
      this.#variants = data.variants;
    }

    this.#checkAvailability = debounce(this.#checkAvailability.bind(this), AVAILABILITY_DEBOUNCE_MS);

    this.refs.selectButton.addEventListener('click', this.#onSelect);
    this.refs.variantSelect.addEventListener('change', this.#onInputChange);
    this.refs.dateInput.addEventListener('change', this.#onDateChange);
    this.refs.timeInput.addEventListener('change', this.#onInputChange);
    this.refs.submitButton.addEventListener('click', this.#onSubmit);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.refs.selectButton.removeEventListener('click', this.#onSelect);
    this.refs.variantSelect.removeEventListener('change', this.#onInputChange);
    this.refs.dateInput.removeEventListener('change', this.#onDateChange);
    this.refs.timeInput.removeEventListener('change', this.#onInputChange);
    this.refs.submitButton.removeEventListener('click', this.#onSubmit);
  }

  #onSelect = () => {
    this.classList.add('is-expanded');
  };

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

  #onInputChange = () => {
    this.#lastAvailability = null;
    this.#checkAvailability();
  };

  #checkAvailability = async () => {
    const start = this.#pickupStartIso();
    const variantGid = this.refs.variantSelect.value;
    if (!start || !variantGid) {
      this.#setStatus('');
      this.refs.submitButton.disabled = true;
      return;
    }

    this.#setStatus(window.Theme?.translations?.rentalCheckingAvailability ?? 'Vérification de la disponibilité…');
    this.refs.submitButton.disabled = true;

    try {
      const params = new URLSearchParams({ model: this.#productGid, variant: variantGid, start });
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
          : 'Aucun vélo disponible pour cette date.',
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
    const variantGid = this.refs.variantSelect.value;
    const variant = this.#variants.find((v) => v.gid === variantGid);
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
        body: JSON.stringify({ model: this.#productGid, variant: variantGid, start }),
      });
      const hold = await holdResponse.json();

      if (!holdResponse.ok) {
        this.#setStatus(hold.message || 'Ce vélo vient d’être réservé par quelqu’un d’autre. Veuillez réessayer.');
        this.#onInputChange();
        return;
      }

      const cartResponse = await fetch(window.Theme.routes.cart_add_url, {
        ...fetchConfig('json'),
        body: JSON.stringify({
          items: [
            {
              id: Number(variant.id),
              quantity: 1,
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
