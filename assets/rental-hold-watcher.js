import { ThemeEvents } from '@theme/events';

/**
 * Sitewide, invisible watcher: releases a rental hold the moment its bike is
 * removed from the cart (drawer or full cart page), instead of leaving the
 * bike blocked for other customers until the cron sweep expires it up to 15
 * minutes later. Works anywhere in the theme since cart removal isn't
 * limited to the product page the hold was created on.
 */
class RentalHoldWatcher extends HTMLElement {
  /** @type {Set<string>} */
  #knownHoldIds = new Set();

  connectedCallback() {
    this.#syncFromCart();
    document.addEventListener(ThemeEvents.cartUpdate, this.#onCartUpdate);
  }

  disconnectedCallback() {
    document.removeEventListener(ThemeEvents.cartUpdate, this.#onCartUpdate);
  }

  async #syncFromCart() {
    try {
      const response = await fetch('/cart.js');
      const cart = await response.json();
      this.#knownHoldIds = this.#extractHoldIds(cart);
    } catch (error) {
      console.error('Failed to sync rental hold watcher from cart:', error);
    }
  }

  /** @param {{ items?: { properties?: Record<string, string> }[] }} cart */
  #extractHoldIds(cart) {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const item of cart.items ?? []) {
      const holdId = item.properties?.['_booking_hold_id'];
      if (holdId) ids.add(holdId);
    }
    return ids;
  }

  /** @param {CustomEvent<{ resource?: unknown }>} event */
  #onCartUpdate = (event) => {
    const cart = /** @type {{ items?: unknown[] } | undefined} */ (event.detail?.resource);
    if (!cart || !Array.isArray(cart.items)) {
      // Some cart updates don't carry a full cart payload — refetch rather
      // than risk missing a removal.
      this.#syncFromCart();
      return;
    }

    const newHoldIds = this.#extractHoldIds(cart);
    for (const holdId of this.#knownHoldIds) {
      if (!newHoldIds.has(holdId)) this.#cancelHold(holdId);
    }
    this.#knownHoldIds = newHoldIds;
  };

  /** @param {string} holdId */
  #cancelHold(holdId) {
    fetch(`/apps/rental/hold/${holdId}/cancel`, { method: 'POST' }).catch((error) => {
      console.error('Failed to release hold after cart removal:', error);
    });
  }
}

if (!customElements.get('rental-hold-watcher')) {
  customElements.define('rental-hold-watcher', RentalHoldWatcher);
}
