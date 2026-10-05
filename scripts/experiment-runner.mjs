export const stages = [
  "Semantic accessible DOM/CSS scaffold from the wireframe; create all fixed controls, IDs, canvas boxes, hidden tooltip and dialog. Do NOT implement simulation JS yet.",
  "Implement the physical intensity function, Canvas interference pattern and intensity curve, PhySim public API and first-frame ready Promise. Keep skeleton styling and IDs.",
  "Implement shared normalization across controls, URL and public API, a<=d, outputs, reset and immediate redraw. Restore URL view state.",
  "Implement curve hover percentage and eta, Home/arrow keyboard probing, synchronized same-x indicator on both canvases, hide on leave.",
  "Audit/fix interference AND sinc-squared diffraction. Center, symmetry, zeros, missing orders, correct ranges. Distinguish full-formula peak versus ideal interference order; display scaling never changes physics.",
  "Implement fixed-reference critical markers for wavelength and separation, with kind/order/value, bright integer and dark half-integer orders, omit outside range. d=6000 nm at eta=.11: lambda660 bright -> lambda440 dark.",
  "Implement inline physical geometry SVG and modal dialog, Escape/Tab focus trap, close button/backdrop and focus return. Label physical D versus display Dsim.",
  "Finish dark/light and grayscale controls, responsive mobile, DPR1/2/3 backing alignment, robust URL/API numeric checks, offline and keyboard usability. Audit ALL frozen requirements."
];
export const modelSpec = `Build a Chinese single-file offline Young double-slit teaching simulator. Never load network resources or libraries. Requirements are frozen:
Title 杨氏双缝干涉仿真; panels 参数调控/干涉条纹图样/归一化光强. Follow wireframe with parameter column left, pattern and curve stacked right; mobile stacked. Canvas horizontal origins and widths must match.
I_N(eta)=sinc(pi*a*eta/lambda)^2*cos(pi*d*eta/lambda)^2, sinc(t)=sin(t)/t and sinc(0)=1. lambda/a/d in nm. eta=(u-u0)/(4*Dsim*Z) in CSS-pixel display coordinates. Physical D is a different geometry quantity. Dsim/Z only change display scale, never physical I or fringe order. Full-intensity peaks differ from ideal m*lambda/d. Dark-fringe-defined central and second-order widths equal; second peak is lower.
Five parameter object keys IN ORDER: wavelength,slitSeparation,slitWidth,screenDistance,zoom. Defaults 550,5000,1000,50,1. Limits [380,750],[1000,10000],[200,3000],[1,100],[1,5]. screenDistance means Dsim. All inputs/API/URL share normalization: nonfinite -> default; clamp; slitWidth=min(slitWidth,slitSeparation). Object contains only five numbers.
DOM: input[type=range] IDs equal parameter keys; output IDs key+'-output'. Markers #wavelength-markers/#slitSeparation-markers. Canvas #interferenceCanvas/#intensityCanvas, curve tabindex=0. #intensity-tooltip hidden initially, show eta and I_N percentage on hover and Home/arrows, hide on pointer leave. Same-x indicator on both charts. #reset-button/#theme-button/#palette-button/#principle-button/#principle-modal/#modal-close-button. Modal role=dialog aria-modal with inline geometry SVG, Escape close, Tab trap, focus return.
window.PhySim: version '0.9.1' candidate; defaults,limits,ready(first-frame Promise),getParams()(copy),setParams(partial)(synchronously normalize and redraw),intensityAtEta(eta,params?)(default current),getCriticalMarkers(params?),render(). Critical markers returns {wavelength:[{kind:'bright'|'dark',order,value}],slitSeparation:[...]}. Fixed eta_ref=.11; bright d*eta_ref/lambda=positive integer; dark=nonnegative integer+.5; include only solutions in respective slider limits. Default bright lambda550/d5000 and dark d2500. d6000 yields lambda660 bright1 and lambda440 dark1.5; do not clamp out-of-range solutions.
URL numeric keys plus theme=auto/light/dark,palette=color/grayscale,compact=0/1. html[data-theme] actual light/dark; html[data-palette]; body[data-compact] true/false. Five output labels include units nm or display ratio. CSP connect-src 'none'; object-src/frame-src 'none'; allow inline scripts/styles only and data images. No fetch/WebSocket/XHR, external font/library/resource.
Native CSS/DOM/Canvas/SVG only. Style readable on desktop1440x900/mobile390x844, no overflow; both canvas same CSS width/left/center. Backing sizes multiply DPR and transform to CSS; resize redraw. file://, HTTP and network-disabled must work. No model credentials, no build tools. Include inline <style id="phy-sim-style"> and <script id="phy-sim-script">; body may be replaced later. All stages keep IDs and previous behavior.`;

export function decodeHtml(content) {
  const start = content.search(/<!doctype html>/i), end = content.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start) throw new Error("No complete HTML in model response");
  return content.slice(start, end + 7);
}
