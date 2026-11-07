/** Ten fictional, owned Sandbox accessories; prices are integer USD cents. */
const rows = [
  ['HBR-C1', 'Harbor USB-C cable 1m', 'cable', 'usb-c-to-usb-c', 1299, 4, { powerWatts: 60, lengthCm: 100, dataMbps: 480 }],
  ['REEF-C1', 'Reef USB-C cable 1m', 'cable', 'usb-c-to-usb-c', 1199, 7, { powerWatts: 60, lengthCm: 100, dataMbps: 480 }],
  ['CURRENT-C2', 'Current USB-C cable 2m', 'cable', 'usb-c-to-usb-c', 1499, 5, { powerWatts: 100, lengthCm: 200, dataMbps: 480 }],
  ['PEBBLE-C1', 'Pebble USB-C charging lead', 'cable', 'usb-c-to-usb-c', 899, 8, { powerWatts: 20, lengthCm: 100, dataMbps: 0 }],
  ['TRAIL-A1', 'Trail USB-A to USB-C cable', 'cable', 'usb-a-to-usb-c', 999, 6, { powerWatts: 18, lengthCm: 100, dataMbps: 480 }],
  ['SPARE-C1', 'Harbor spare USB-C cable 1m', 'cable', 'usb-c-to-usb-c', 1099, 0, { powerWatts: 60, lengthCm: 100, dataMbps: 480 }],
  ['CHARGE-C20', 'Cove USB-C charger 20W', 'charger', 'usb-c-output', 2499, 5, { powerWatts: 20, ports: 1 }],
  ['CHARGE-C30', 'Bay USB-C charger 30W', 'charger', 'usb-c-output', 2299, 3, { powerWatts: 30, ports: 1 }],
  ['STAND-TAB', 'Studio tablet stand', 'stand', 'none', 1899, 4, { maxWidthMm: 200, maxLoadGrams: 1000 }],
  ['STAND-PHONE', 'Pocket phone stand', 'stand', 'none', 999, 6, { maxWidthMm: 100, maxLoadGrams: 300 }],
];
export const CATALOG = Object.freeze(rows.map(([sku, name, kind, connector, unitAmountCents, stock, attributes]) =>
  Object.freeze({ sku, name, kind, connector, unitAmountCents, currency: 'USD', stock, attributes: Object.freeze(attributes) })));
export function initialInventory() { return CATALOG.map(item => ({ ...item, attributes: { ...item.attributes } })); }
