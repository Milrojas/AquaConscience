# AquaConscience – Backend + Modelo de ML

Node.js + Express + SQLite, más un microservicio Python (Flask + scikit-learn) que ejecuta el
modelo Isolation Forest del notebook.

```
Navegador ──► Node (server.js) ──► SQLite (aquaconscience.db)
                  │                    ▲   users, sensors, readings, alerts, bills
                  │ POST /analyze      │   ref_* (los 3 CSV)
                  ▼                    │
           Servicio ML (ml/service.py) ─┘ entrena y lee ref_* desde la misma BD
```

## Estructura
```
server.js        API REST (+ /api/chat, /api/insights, /api/bills)
db.js            Esquema: users, households, sensors, readings, alerts, bills + ref_*
pricing.js       Precio del m³ (COP) y conversión litros -> pesos, usados en toda la app
bills.js         Facturas: CRUD y comparativa "medido por sensores" vs. "facturado"
ml.js            Cliente del servicio ML: serie diaria del usuario, alertas, estadísticas, respaldo
chatbot.js       Asistente: responde con datos reales, costos, factura + resultados del modelo
ml/aquaml.py     Núcleo del modelo (features, entrenamiento, alertas) – sale del notebook
ml/service.py    Servicio Flask  POST /analyze · GET /health   (solo 127.0.0.1)
ml/import_data.py  Carga los CSV en la BD (tablas ref_*)
ml/train.py      Evalúa y entrena; guarda ml/models/*.joblib
ml/consejos.json Textos de consejos (los usan Python y Node)
data/            Los 3 CSV originales
public/          Frontend (index.html, css/styles.css, css/bill.css, js/app.js, js/bill.js)
```

## Puesta en marcha
Requisitos: Node ≥ 22 y Python ≥ 3.10.
```bash
npm install
pip install -r ml/requirements.txt

npm run import-data      # CSV -> tablas ref_* de aquaconscience.db (una vez)
npm run train            # opcional: imprime métricas y guarda los modelos
                         # (si no lo haces, el servicio entrena solo al primer arranque)
Copiar completo en la terminal
$env:JWT_SECRET="tu_secreto"
>> npm start
```
Abre http://localhost:3000. Si el servicio de ML está apagado, la app **sigue funcionando**:
usa una regla simple (día vs. promedio de los 7 anteriores) y el chatbot lo avisa.

Variables: `ML_URL` (por defecto `http://127.0.0.1:5001`), `ML_PORT`, `AQUA_DB`, `TZ_APP`, `JWT_SECRET`,
`PRECIO_M3` (por defecto `3420.84`, COP por metro cúbico).

## Factura y precio del agua
**Precio.** Todo el consumo de la app se valora a **$3.420,84 COP por m³** ($3,42 por litro): resumen semanal,
límite recomendado, filas de actividad, recomendaciones y respuestas del asistente. El valor vive en
`pricing.js` (se puede cambiar con `PRECIO_M3`) y el servidor lo envía al frontend en `/api/dashboard` (`precioM3`).

**Ingresar una factura** (pestaña *Factura*): periodo facturado (desde/hasta), consumo facturado en m³,
total a pagar y, opcionalmente, el número de factura. Guardar de nuevo el mismo periodo actualiza la factura.

**Escanear.** El botón *Escanear o subir factura* acepta foto (JPG/PNG…) o PDF y rellena el formulario:
- Fotos: OCR en el navegador con Tesseract.js (español). PDF: se lee el texto incrustado con pdf.js y, si es un
  PDF escaneado, se hace OCR de las primeras 3 páginas.
- Se buscan el periodo, el consumo en m³, el total a pagar y el número de factura. **Nada se guarda sin que el
  usuario revise los datos**: el OCR puede equivocarse.
- El archivo no se sube al servidor; solo se guardan los datos confirmados (`source = 'scan'`).
- Las librerías se descargan de jsDelivr la primera vez que se escanea, así que hace falta conexión a Internet.
  Para uso sin conexión, copia `tesseract.js` y `pdfjs-dist` a `public/` y cambia las URL al inicio de `public/js/bill.js`.

**Comparativa.** Para cada factura se suman las lecturas de los sensores dentro del periodo (zona `TZ_APP`) y se
compara con los m³ facturados:
| Estado | Cuándo |
|---|---|
| `coincide` | diferencia dentro de ±10 % |
| `facturado_mayor` | los sensores midieron más de 10 % menos que lo facturado (cargos fijos, lecturas estimadas, fuga fuera del sensor) |
| `medido_mayor` | los sensores midieron más de 10 % más que lo facturado |
| `sin_datos` | menos de 3 días con lecturas en el periodo |

Si hay lecturas en menos del 80 % de los días del periodo, la comparación se **proyecta** al periodo completo
(`estimado: true`) y la interfaz lo avisa. También se muestra el precio real pagado por m³ (total / m³) frente al
precio asociado, lo que deja ver cargos fijos y otros conceptos.

## Límite de consumo y alerta por exceso
Se aplica un desincentivo a quien supera el **doble del consumo básico de subsistencia: 22 m³ al mes
(44 m³ en el bimestre)**. Por cada m³ que supere ese límite se cobra un valor adicional en la factura
(en Bogotá ronda **$3.380 – $3.481 por m³**). Está en `pricing.js` y se puede ajustar con `LIMITE_MES_M3`,
`RECARGO_M3_MIN` y `RECARGO_M3_MAX`.

`limits.js` suma las lecturas de los sensores del **mes** y del **bimestre calendario** en curso (ene-feb,
mar-abr, …) y genera un aviso:
| Nivel | Cuándo |
|---|---|
| `excedido` | el mes supera 22 m³ o el bimestre supera 44 m³ → muestra los m³ de exceso y el valor adicional estimado (rango) |
| `riesgo` | aún no supera el límite, pero a este ritmo lo superaría al cierre (se proyecta desde el día 7) |
| sin aviso | dentro del límite |

El aviso sale como tarjeta en **Inicio**, como barras de avance en la pestaña **Factura**, entre las
recomendaciones y en el **asistente** (“¿cuánto es el recargo por exceso?”). Cada factura guardada también
indica si supera el límite de su periodo (22 m³ × meses) y el valor adicional estimado.
`/api/dashboard` devuelve `excess` con todos estos datos. Es una estimación: el cobro real lo define la empresa.

## Cómo se conecta cada pieza
**CSV → base de datos.** `import_data.py` crea/llena `ref_hogares`, `ref_consumo_general` y
`ref_consumo_actividades` (con validaciones). Son los datos de entrenamiento y de comparación.

**App → modelo.** `ml.js` agrupa las lecturas del usuario por día (zona `TZ_APP`, sin contar el día en curso) y
las manda a `/analyze`. Python calcula las mismas variables del notebook (litros por persona, ratio vs.
promedio de 7 días, cambio vs. ayer, fin de semana) y devuelve puntaje y alerta por día.
- **Modelo A (general):** necesita ≥ 8 días completos de lecturas.
- **Modelo B (actividades):** la actividad de cada lectura se mapea a las 5 categorías del modelo
  (Ducha/Lavamanos → aseo personal, Sanitario → inodoro, Lavado de platos/Preparar comida → cocina,
  Lavadora → lavado de ropa, Limpieza → limpieza). Riego y "Consumo general" cuentan en el total pero no tienen
  categoría. Las categorías no medidas se completan con la mediana típica; se exigen ≥ 2 medidas.
- Las alertas se guardan en la tabla `alerts` (historial) y salen en `/api/dashboard` (`alerts`, `ml`).

**Chatbot.** `POST /api/chat {message, history}` → `{reply}` (lo que ya esperaba `app.js`). Entiende: cómo voy
esta semana, hoy/ayer, cuánto cuesta mi consumo, precio del m³, si mi factura coincide con lo medido,
¿hubo algo raro?, ¿dónde gasto más?, comparación con hogares similares, fugas, consejos y sensores.
Para agregar preguntas, añade una entrada a `INTENTS` en `chatbot.js`.

## Endpoints
| Método | Ruta | Descripción |
|---|---|---|
| POST | /api/chat | Asistente con datos reales, costos, factura y alertas del modelo |
| GET | /api/insights | Puntajes por día de cada modelo, alertas y estadísticas |
| GET | /api/ml/status | Estado del servicio de ML |
| GET | /api/dashboard | Incluye `alerts`, `ml`, `precioM3`, `totalCost`, `weeklyLimitCost` |
| GET | /api/bills | `{precio_m3, bills[]}` con la comparativa de cada factura |
| POST | /api/bills | `{period_start, period_end, m3, total, invoice_number?, source?}` (crea o actualiza el periodo) |
| DELETE | /api/bills/:id | Elimina una factura |

## Notas
- `AQUACONSIENCE_hogares.csv` es en realidad un Excel (.xlsx) con extensión .csv; el importador lo detecta solo.
- Los datos de referencia son sintéticos (columna `es_anomalia_sintetica`); las métricas del modelo
  (ROC-AUC ≈ 1.0) reflejan eso y no se garantizan con datos reales de sensores.
- El modo demo (`demo:true` en `finishOnboarding()` de `app.js`) genera 21 días con un día anómalo
  hace 3 días, para que se vean las alertas. Con él, una factura de 30 días se compara por proyección
  (solo hay ~21 días de lecturas). Quítalo cuando uses sensores reales.
  Los usuarios creados antes con 7 días de demo no tendrán suficiente historial: crea una cuenta nueva.
- La tabla `bills` se crea sola al arrancar; no hace falta migrar bases existentes.
- Los `.joblib` dependen de la versión de scikit-learn; si cambia, el servicio reentrena solo.
- El servicio Flask escucha solo en 127.0.0.1 y no tiene autenticación. En producción usa gunicorn y no lo expongas.