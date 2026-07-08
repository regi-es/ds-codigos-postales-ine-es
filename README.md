# Códigos postales ⇄ municipios de España (INE)

Dataset de códigos postales de España y sus municipios, generado directamente
de los datos abiertos del INE y actualizado automáticamente. *(English
summary below.)*

- **Fresco**: un workflow mensual comprueba si el INE ha publicado una nueva
  edición y regenera los datos. Cada actualización queda etiquetada con la
  edición del callejero (p. ej. `2026-01`).
- **Trazable**: `data/metadata.json` indica exactamente qué ediciones del INE
  produjeron los datos.
- **Validado**: se descartan filas con códigos malformados o provincias fuera
  del rango 01–52.
- **Sin dependencias**: el generador es un único script de Node.js ≥ 20.

## Datos

| Archivo | Contenido |
| --- | --- |
| [`data/codigos_postales_municipios.csv`](data/codigos_postales_municipios.csv) | Pares `codigo_postal,municipio_id,municipio_nombre` |
| [`data/municipios.json`](data/municipios.json) | `municipio_id` → `{ nombre, codigos_postales[] }` |
| [`data/codigos_postales.json`](data/codigos_postales.json) | `codigo_postal` → `[municipio_id]` (índice inverso) |
| [`data/metadata.json`](data/metadata.json) | Ediciones del INE, recuentos |

`municipio_id` es el código INE de 5 dígitos (2 de provincia + 3 de
municipio). Ejemplos:

```csv
codigo_postal,municipio_id,municipio_nombre
29620,29901,Torremolinos
```

```jsonc
// municipios.json
"29901": {"nombre":"Torremolinos","codigos_postales":["29620"]}

// codigos_postales.json
"29620": ["29901"]
```

### Consumo

Directamente desde GitHub o vía CDN (jsDelivr), fijando una edición con la
etiqueta si se quiere reproducibilidad:

```
https://raw.githubusercontent.com/regi-es/ds-codigos-postales-ine-es/master/data/codigos_postales.json
https://cdn.jsdelivr.net/gh/regi-es/ds-codigos-postales-ine-es@2026-01/data/codigos_postales.json
```

## Fuentes

Todo procede de dos datasets abiertos del INE:

1. **[Callejero del Censo Electoral](https://www.ine.es/prodyser/callejero/)**
   (`caj_esp_MMYYYY.zip`): el callejero nacional. Su fichero TRAM lista cada
   tramo de vía con el código INE del municipio y el código postal que lo
   sirve. Se publica dos veces al año (referencias 31 de diciembre y 30 de
   junio).
2. **[Relación de municipios y sus códigos](https://www.ine.es/daco/daco42/codmun/codmunmapa.htm)**
   (`diccionarioYY.xlsx`): el diccionario oficial de municipios, del que salen
   los nombres oficiales (p. ej. `"Gineta, La"`).

### Notas sobre los datos

- Un código postal puede pertenecer a **varios municipios** (frecuente en
  zonas rurales): por eso `codigos_postales.json` devuelve una lista.
- Un municipio puede tener códigos postales de una **provincia distinta** a
  la suya: hay tramos fronterizos servidos por carterías vecinas. No es un
  error del dataset.
- La granularidad es la del callejero del INE: si el INE no asocia un código
  postal a ningún tramo, no aparece aquí.

## Compatibilidad con `inigoflores/ds-codigos-postales-ine-es`

`data/codigos_postales_municipios.csv` mantiene la misma ruta, cabecera y
formato que el CSV de
[inigoflores/ds-codigos-postales-ine-es](https://github.com/inigoflores/ds-codigos-postales-ine-es),
así que basta cambiar el propietario en la URL. Diferencias deliberadas:

- Datos regenerados de la edición vigente del INE (el formato del callejero
  cambió en julio de 2025).
- Filas con códigos inválidos descartadas (p. ej. el CSV original contiene
  códigos postales de la inexistente provincia `00`).
- Nombres de municipio de la edición vigente del diccionario oficial.

## Regenerar

```sh
node scripts/generate.mjs
```

Descarga la última edición publicada de cada fuente (~50 MB) y reescribe
`data/`. La salida es determinista: mismas ediciones ⇒ mismos bytes.

## Licencia

- **Código** (`scripts/`): [MIT](LICENSE).
- **Datos**: elaboración propia a partir de datos del
  [Instituto Nacional de Estadística](https://www.ine.es), reutilizados
  conforme a la Ley 37/2007 sobre reutilización de la información del sector
  público. Se requiere citar la fuente: *Fuente: sitio web del INE:
  www.ine.es*.

---

## English summary

Spanish postal code ⇄ municipality dataset, generated directly from Spain's
National Statistics Institute (INE) open data and refreshed automatically. A
monthly workflow picks up new INE editions; each refresh is tagged with the
street-directory edition (e.g. `2026-01`) so consumers can pin versions via
jsDelivr. `data/codigos_postales_municipios.csv` is a drop-in replacement for
the CSV in `inigoflores/ds-codigos-postales-ine-es` (same path, header and
quoting); `data/municipios.json` and `data/codigos_postales.json` provide the
two lookup directions pre-built. Code is MIT; data is derived from INE and
requires source attribution (*Fuente: sitio web del INE: www.ine.es*).
