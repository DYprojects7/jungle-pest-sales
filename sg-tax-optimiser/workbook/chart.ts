/**
 * Adds charts to a written .xlsx file, and gives the file's parts fixed dates.
 *
 * ExcelJS cannot write charts, so the build adds them afterwards: the workbook is a zip of XML parts, and a chart
 * is three small parts (the chart, the drawing that places it on the sheet, and their relationships) plus one
 * `<drawing>` element in the sheet. Only the standard DrawingML chart elements that Excel itself writes are used,
 * in the order the file format requires, with cell references and no cached values, so Excel, LibreOffice and
 * Google Sheets each draw the chart from the sheet's own numbers.
 *
 * The chart is a stacked area chart on an evenly spaced bottom axis: every application draws one the same way,
 * and a filled block reads as a rung of the ladder where a line would not.
 *
 * `jszip` is the zip library ExcelJS itself depends on.
 */
import JSZip from 'jszip';

/** One filled series. References are absolute and sheet-qualified, e.g. `Ladder!$AL$29:$AL$229`. */
export interface ChartSeries {
  nameRef: string;
  valuesRef: string;
  /** Fill colour, RGB, e.g. "1E6B45". */
  color: string;
}

export interface ChartSpec {
  /** Name of the sheet the chart sits on. */
  sheet: string;
  /** Cell box the chart covers: zero-based column / row of its top-left and bottom-right corners. */
  from: { col: number; row: number };
  to: { col: number; row: number };
  title: string;
  xTitle: string;
  yTitle: string;
  xNumFmt: string;
  yNumFmt: string;
  /** The labels of the evenly spaced positions along the bottom axis (text: an amount, or nothing). */
  categoriesRef: string;
  /** One axis label for every this many points. */
  labelEvery: number;
  series: ChartSeries[];
}

const NS = {
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  main: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  sheetDrawing: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  packageRels: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const;
const TYPE = {
  drawingRel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
  chartRel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  drawingContent: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  chartContent: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
} as const;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const FONT = 'Calibri';
const INK = '1F2933';
const MUTED = '5B6B7B';
const GRID = 'E3E9F0';
const EDGE = 'CBD5E1';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A run of text for a chart or axis title. */
function richText(text: string, sizePt: number, bold: boolean, rotated = false): string {
  const size = Math.round(sizePt * 100);
  const run = `sz="${size}" b="${bold ? 1 : 0}"`;
  const fill = `<a:solidFill><a:srgbClr val="${bold ? INK : MUTED}"/></a:solidFill><a:latin typeface="${FONT}"/>`;
  return (
    `<c:tx><c:rich><a:bodyPr${rotated ? ' rot="-5400000" vert="horz"' : ''}/><a:lstStyle/>` +
    `<a:p><a:pPr><a:defRPr ${run}>${fill}</a:defRPr></a:pPr><a:r><a:rPr lang="en-US" ${run}>${fill}</a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>` +
    `</c:rich></c:tx><c:overlay val="0"/>`
  );
}

function seriesXml(series: ChartSeries, index: number, categoriesRef: string): string {
  return (
    `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>` +
    `<c:tx><c:strRef><c:f>${esc(series.nameRef)}</c:f></c:strRef></c:tx>` +
    `<c:spPr><a:solidFill><a:srgbClr val="${series.color}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${series.color}"/></a:solidFill></a:ln></c:spPr>` +
    `<c:cat><c:strRef><c:f>${esc(categoriesRef)}</c:f></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${esc(series.valuesRef)}</c:f></c:numRef></c:val>` +
    `</c:ser>`
  );
}

const axisLine = (rgb: string): string => `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${rgb}"/></a:solidFill></a:ln></c:spPr>`;

/**
 * The bottom axis: evenly spaced positions. Only every `labelEvery`-th position has a label (the cells in between
 * hold empty text), the labels are kept level, and the label and tick intervals say the same, so an application
 * that honours the interval and one that thins labels by itself both show the same round figures.
 */
function categoryAxisXml(options: { id: number; crossId: number; title: string; numFmt: string; labelEvery: number }): string {
  return (
    `<c:catAx><c:axId val="${options.id}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="b"/>` +
    `<c:title>${richText(options.title, 9, false)}</c:title>` +
    `<c:numFmt formatCode="${esc(options.numFmt)}" sourceLinked="0"/>` +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    axisLine(EDGE) +
    `<c:txPr><a:bodyPr rot="0" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="${MUTED}"/></a:solidFill><a:latin typeface="${FONT}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>` +
    `<c:crossAx val="${options.crossId}"/><c:crosses val="autoZero"/>` +
    `<c:auto val="0"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>` +
    `<c:tickLblSkip val="${options.labelEvery}"/><c:tickMarkSkip val="${options.labelEvery}"/><c:noMultiLvlLbl val="1"/></c:catAx>`
  );
}

/** The left axis: the saving per dollar, from zero. The areas start on it (`midCat`), so the first block has no gap. */
function valueAxisXml(options: { id: number; crossId: number; title: string; numFmt: string }): string {
  return (
    `<c:valAx><c:axId val="${options.id}"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="l"/>` +
    `<c:majorGridlines>${axisLine(GRID)}</c:majorGridlines>` +
    `<c:title>${richText(options.title, 9, false, true)}</c:title>` +
    `<c:numFmt formatCode="${esc(options.numFmt)}" sourceLinked="0"/>` +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    axisLine(EDGE) +
    `<c:crossAx val="${options.crossId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
  );
}

/** The chart part: a stacked area chart, one filled series over the other. */
export function chartXml(spec: ChartSpec): string {
  const xAxis = 510_001;
  const yAxis = 510_002;
  return (
    `${XML_HEAD}<c:chartSpace xmlns:c="${NS.chart}" xmlns:a="${NS.main}" xmlns:r="${NS.rel}">` +
    `<c:date1904 val="0"/><c:roundedCorners val="0"/>` +
    `<c:chart><c:title>${richText(spec.title, 11, true)}</c:title><c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>` +
    `<c:areaChart><c:grouping val="stacked"/><c:varyColors val="0"/>` +
    spec.series.map((series, index) => seriesXml(series, index, spec.categoriesRef)).join('') +
    `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` +
    `<c:axId val="${xAxis}"/><c:axId val="${yAxis}"/></c:areaChart>` +
    categoryAxisXml({ id: xAxis, crossId: yAxis, title: spec.xTitle, numFmt: spec.xNumFmt, labelEvery: spec.labelEvery }) +
    valueAxisXml({ id: yAxis, crossId: xAxis, title: spec.yTitle, numFmt: spec.yNumFmt }) +
    `</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="zero"/></c:chart>` +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${EDGE}"/></a:solidFill></a:ln></c:spPr>` +
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="${MUTED}"/></a:solidFill><a:latin typeface="${FONT}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>` +
    `</c:chartSpace>`
  );
}

/** The drawing part: one frame, anchored to the cell box, that shows the chart. */
function drawingXml(spec: ChartSpec, relId: string, shapeId: number): string {
  const corner = (tag: string, cell: { col: number; row: number }): string =>
    `<xdr:${tag}><xdr:col>${cell.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${cell.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  return (
    `${XML_HEAD}<xdr:wsDr xmlns:xdr="${NS.sheetDrawing}" xmlns:a="${NS.main}">` +
    `<xdr:twoCellAnchor editAs="oneCell">${corner('from', spec.from)}${corner('to', spec.to)}` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${shapeId}" name="${esc(spec.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS.chart}"><c:chart xmlns:c="${NS.chart}" xmlns:r="${NS.rel}" r:id="${relId}"/></a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`
  );
}

function relationshipsXml(entries: { id: string; type: string; target: string }[]): string {
  return (
    `${XML_HEAD}<Relationships xmlns="${NS.packageRels}">` +
    entries.map((entry) => `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${esc(entry.target)}"/>`).join('') +
    `</Relationships>`
  );
}

async function text(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`The workbook has no part ${path}`);
  return file.async('string');
}

function unescape(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : unescape(match[1]);
}

/** The path of a sheet's XML part, e.g. `xl/worksheets/sheet3.xml`. */
async function sheetPath(zip: JSZip, sheetName: string): Promise<string> {
  const workbook = await text(zip, 'xl/workbook.xml');
  const sheetTag = (workbook.match(/<sheet\b[^>]*>/g) ?? []).find((tag) => attribute(tag, 'name') === sheetName);
  const relId = sheetTag ? attribute(sheetTag, 'r:id') : undefined;
  if (!relId) throw new Error(`The workbook has no sheet named "${sheetName}"`);
  const rels = await text(zip, 'xl/_rels/workbook.xml.rels');
  const relTag = (rels.match(/<Relationship\b[^>]*>/g) ?? []).find((tag) => attribute(tag, 'Id') === relId);
  const target = relTag ? attribute(relTag, 'Target') : undefined;
  if (!target) throw new Error(`Cannot find the part for sheet "${sheetName}"`);
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

/** Elements that must come after `<drawing>` in a worksheet part. */
const AFTER_DRAWING = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst', '</worksheet>'];

/**
 * The date given to every part of the file. A zip records a time for each entry; left alone it is the moment of
 * the build, so two builds of the same workbook would differ byte for byte.
 */
export const DEFAULT_PART_DATE = new Date(Date.UTC(2020, 0, 1));

/** Writes the zip with every entry (folders included) dated `date`, in a fixed order of compression. */
async function generate(zip: JSZip, date: Date): Promise<Buffer> {
  zip.forEach((_path, entry) => {
    entry.date = date;
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'DOS' });
}

/** Returns the .xlsx unchanged except that every part carries the fixed date. */
export async function withFixedDates(xlsx: Buffer | Uint8Array, date: Date = DEFAULT_PART_DATE): Promise<Buffer> {
  return generate(await JSZip.loadAsync(xlsx), date);
}

/**
 * Returns the .xlsx with the charts added and every part dated `date`. Each chart must be on a sheet that has no
 * drawing yet.
 */
export async function addCharts(xlsx: Buffer | Uint8Array, charts: ChartSpec[], date: Date = DEFAULT_PART_DATE): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xlsx);
  let contentTypes = await text(zip, '[Content_Types].xml');
  let number = 1;

  for (const spec of charts) {
    while (zip.file(`xl/drawings/drawing${number}.xml`) || zip.file(`xl/charts/chart${number}.xml`)) number++;
    const drawingPath = `xl/drawings/drawing${number}.xml`;
    const chartPath = `xl/charts/chart${number}.xml`;

    // The sheet points at the drawing…
    const path = await sheetPath(zip, spec.sheet);
    let sheet = await text(zip, path);
    if (/<drawing\b/.test(sheet)) throw new Error(`Sheet "${spec.sheet}" already has a drawing`);
    const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
    const existing = zip.file(relsPath) ? await text(zip, relsPath) : relationshipsXml([]);
    let relNumber = 1;
    while (existing.includes(`Id="rId${relNumber}"`)) relNumber++;
    const sheetRelId = `rId${relNumber}`;
    zip.file(
      relsPath,
      existing.replace('</Relationships>', `<Relationship Id="${sheetRelId}" Type="${TYPE.drawingRel}" Target="../drawings/drawing${number}.xml"/></Relationships>`),
    );
    const at = Math.min(...AFTER_DRAWING.map((tag) => sheet.indexOf(tag)).filter((index) => index >= 0));
    if (!Number.isFinite(at)) throw new Error(`Sheet "${spec.sheet}" has no closing tag`);
    sheet = `${sheet.slice(0, at)}<drawing xmlns:r="${NS.rel}" r:id="${sheetRelId}"/>${sheet.slice(at)}`;
    zip.file(path, sheet);

    // …the drawing points at the chart.
    zip.file(drawingPath, drawingXml(spec, 'rId1', number + 1));
    zip.file(`xl/drawings/_rels/drawing${number}.xml.rels`, relationshipsXml([{ id: 'rId1', type: TYPE.chartRel, target: `../charts/chart${number}.xml` }]));
    zip.file(chartPath, chartXml(spec));
    contentTypes = contentTypes.replace(
      '</Types>',
      `<Override PartName="/${drawingPath}" ContentType="${TYPE.drawingContent}"/><Override PartName="/${chartPath}" ContentType="${TYPE.chartContent}"/></Types>`,
    );
    number++;
  }

  zip.file('[Content_Types].xml', contentTypes);
  return generate(zip, date);
}
