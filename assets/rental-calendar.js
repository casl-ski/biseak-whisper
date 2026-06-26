/**
 * Self-contained month-grid calendar: renders day cells colored by
 * availability status (normal / half-gray "partial" / gray "unavailable"),
 * lets the shopper pick a date, and reports the choice via a
 * `rentalcalendar:select` event. Pure rendering + selection — the parent
 * widget owns fetching data from the rental app and calling `setData()`.
 *
 * All date math here uses plain Y/M/D integers via the Date constructor's
 * local-time form (`new Date(year, month, day)`) and reads them back with
 * `getFullYear`/`getMonth`/`getDate` — this never crosses into a UTC
 * instant, so it's calendar arithmetic only and safe regardless of the
 * shopper's browser timezone (unlike the actual booking timestamps, which
 * do need real timezone handling elsewhere).
 *
 * @typedef {{ status: 'available' | 'partial' | 'unavailable'; slots: Record<string, boolean> }} DayInfo
 */
export class RentalCalendar extends HTMLElement {
  /** @type {Record<string, DayInfo>} */
  #days = {};
  /** @type {Date} first day of the currently displayed month */
  #visibleMonth = new Date();
  /** @type {string | null} */
  #selectedDate = null;
  /** @type {string} */
  #minDate = '';
  /** @type {string} */
  #maxDate = '';

  connectedCallback() {
    const today = new Date();
    this.#visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    this.addEventListener('click', this.#onClick);
    this.#render();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
  }

  /**
   * @param {Record<string, DayInfo>} days
   * @param {string} minDate - "YYYY-MM-DD", earliest selectable date
   * @param {string} maxDate - "YYYY-MM-DD", latest selectable date
   */
  setData(days, minDate, maxDate) {
    this.#days = days;
    this.#minDate = minDate;
    this.#maxDate = maxDate;
    if (this.#selectedDate && this.#days[this.#selectedDate]?.status === 'unavailable') {
      this.#selectedDate = null;
    }
    this.#render();
  }

  /** @returns {string | null} */
  get selectedDate() {
    return this.#selectedDate;
  }

  /** @returns {Record<string, boolean>} */
  get selectedDaySlots() {
    return (this.#selectedDate && this.#days[this.#selectedDate]?.slots) || {};
  }

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target);

    const dayButton = target.closest('button[data-date]');
    if (dayButton instanceof HTMLButtonElement && !dayButton.disabled) {
      this.#selectedDate = dayButton.dataset.date ?? null;
      this.#render();
      this.dispatchEvent(new CustomEvent('rentalcalendar:select', { detail: { date: this.#selectedDate }, bubbles: true }));
      return;
    }

    const navButton = target.closest('button[data-nav]');
    if (navButton instanceof HTMLButtonElement && !navButton.disabled) {
      const delta = navButton.dataset.nav === 'next' ? 1 : -1;
      this.#visibleMonth = new Date(this.#visibleMonth.getFullYear(), this.#visibleMonth.getMonth() + delta, 1);
      this.#render();
    }
  };

  /** @param {Date} date @returns {string} "YYYY-MM-DD" */
  #dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  #render() {
    const year = this.#visibleMonth.getFullYear();
    const month = this.#visibleMonth.getMonth();
    const monthLabel = this.#visibleMonth.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' });

    const firstOfMonth = new Date(year, month, 1);
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7; // Monday-first grid
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const prevMonthLastDayKey = this.#dateKey(new Date(year, month, 0));
    const canGoPrev = !this.#minDate || prevMonthLastDayKey >= this.#minDate;
    const nextMonthFirstDayKey = this.#dateKey(new Date(year, month + 1, 1));
    const canGoNext = !this.#maxDate || nextMonthFirstDayKey <= this.#maxDate;

    let cells = '';
    for (let i = 0; i < leadingBlanks; i++) {
      cells += '<span class="rental-calendar__cell rental-calendar__cell--blank"></span>';
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = this.#dateKey(new Date(year, month, day));
      const outOfFetchedRange = (this.#minDate && dateKey < this.#minDate) || (this.#maxDate && dateKey > this.#maxDate);
      const status = outOfFetchedRange ? null : this.#days[dateKey]?.status;
      const disabled = outOfFetchedRange || !status || status === 'unavailable';
      const isSelected = dateKey === this.#selectedDate;

      const classes = ['rental-calendar__cell'];
      if (status) classes.push(`rental-calendar__cell--${status}`);
      if (isSelected) classes.push('rental-calendar__cell--selected');

      cells += `<button type="button" class="${classes.join(' ')}" data-date="${dateKey}" ${disabled ? 'disabled' : ''}>${day}</button>`;
    }

    this.innerHTML = `
      <div class="rental-calendar__header">
        <button type="button" data-nav="prev" aria-label="Mois précédent" ${canGoPrev ? '' : 'disabled'}>‹</button>
        <span class="rental-calendar__month-label">${monthLabel}</span>
        <button type="button" data-nav="next" aria-label="Mois suivant" ${canGoNext ? '' : 'disabled'}>›</button>
      </div>
      <div class="rental-calendar__weekdays">
        <span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span>
      </div>
      <div class="rental-calendar__grid">${cells}</div>
    `;
  }
}

if (!customElements.get('rental-calendar')) {
  customElements.define('rental-calendar', RentalCalendar);
}
