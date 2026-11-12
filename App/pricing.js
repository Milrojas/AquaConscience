/* Precio del agua y límites de consumo asociados a toda la app (COP / m³).
 * Todo se puede sobreescribir con variables de entorno si cambia la tarifa. */
const PRICE_M3 = Number(process.env.PRECIO_M3) || 3420.84;
const PRICE_L = PRICE_M3 / 1000;

/* Desincentivo al consumo excesivo: se aplica a quien supera el doble del consumo básico de
 * subsistencia, fijado en 22 m³ al mes (44 m³ en el bimestre). Cada m³ que supere el límite
 * lleva un valor adicional en la factura (en Bogotá ronda $3.380 – $3.481 por m³). */
const LIMITE_MES_M3 = Number(process.env.LIMITE_MES_M3) || 22;
const LIMITE_BIMESTRE_M3 = LIMITE_MES_M3 * 2;
const RECARGO_M3_MIN = Number(process.env.RECARGO_M3_MIN) || 3380;
const RECARGO_M3_MAX = Number(process.env.RECARGO_M3_MAX) || 3481;

const costL = liters => liters * PRICE_L;            // litros -> COP
const cop = (n, dec = 0) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: dec, maximumFractionDigits: dec
}).format(n);

module.exports = { PRICE_M3, PRICE_L, costL, cop, LIMITE_MES_M3, LIMITE_BIMESTRE_M3, RECARGO_M3_MIN, RECARGO_M3_MAX };