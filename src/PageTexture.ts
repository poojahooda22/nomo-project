import * as THREE from 'three';

/**
 * The page, rasterised to a GPU texture.
 *
 * The obvious way to build this is to re-declare the layout in Canvas2D:
 * read the design, hardcode the positions, paint. That is what a text
 * rasteriser normally does, and it works when the source is a bag of numeric
 * properties.
 *
 * It is the wrong approach here, because this layout is not a bag of
 * numbers. It is a CSS grid built from clamp(), aspect-ratio, negative
 * percentage margins, vertical writing mode and two breakpoints. Re-deriving
 * that by hand creates a second source of truth for the layout, and the two
 * drift apart the first time anyone edits the stylesheet. Same failure as
 * putting two owners on one property, one level up.
 *
 * So nothing here decides where anything goes. The browser performs the
 * layout, this file measures the result and paints it. Every position comes
 * from getBoundingClientRect or from a Range over a text node. The
 * stylesheet stays the only place the design is described, and a CSS change
 * is picked up on the next rebuild without a line changing here.
 *
 * Text is drawn one character at a time, at the exact box the browser gave
 * that character. Drawing whole strings and trusting Canvas2D to reproduce
 * the browser's letter-spacing and kerning gets close, then drifts several
 * pixels by the end of a long line. Per-character placement cannot drift,
 * because every glyph is independently anchored to a measured box.
 *
 * The cost is a full re-raster on resize and on font load. That is fine:
 * this runs on layout changes, not per frame.
 */

/** Text nodes holding only whitespace paint nothing and cost a Range each. */
const WHITESPACE = /^\s*$/;

export interface PageTextureOptions {
  /** Subtree to rasterise. Everything visible inside it is painted. */
  root: HTMLElement;
  /**
   * The renderer whose drawing buffer this texture is sampled against.
   *
   * Taken as the renderer rather than a DPR number on purpose. Computing the
   * device size here independently is the obvious version and it is subtly
   * wrong: three floors `css * pixelRatio` and the intuitive thing to write
   * is round, so at a fractional DPR the two disagree by one pixel. The
   * texture is then resampled across the quad instead of landing on it, and
   * every glyph picks up a permanent half-texel smear. Measured at DPR 1.25:
   * identical glyph bounding boxes, 25% more lit pixels, 55% more ink.
   *
   * Reading the size back from the renderer makes the disagreement
   * impossible rather than merely unlikely.
   */
  renderer: THREE.WebGLRenderer;
}

export class PageTexture {
  readonly texture: THREE.CanvasTexture;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly root: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly bufferSize = new THREE.Vector2();
  /** CSS-pixel to texel scale, per axis. Not necessarily equal. */
  private scaleX = 1;
  private scaleY = 1;
  private disposed = false;

  constructor(options: PageTextureOptions) {
    this.root = options.root;
    this.renderer = options.renderer;

    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('PageTexture: 2D context unavailable.');
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    /* Sampled 1:1 with the frame, so there is no minification to filter and
       no mip chain worth building. */
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    /* Deliberately NOT tagged sRGB, which looks like the careful choice and
       is the wrong one here. Tagging it asks three to decode to linear on
       sample; the composite then has to re-encode, and any mismatch between
       the two shows up as a washed-out page.
     *
     * The canvas already holds exactly the sRGB bytes the browser would have
     * painted, and CSS does its blending on those same non-linear values. So
     * the bytes are carried through untouched and blended in the space they
     * were authored in, which is both fewer conversions and the only way the
     * result can match what the DOM path produces today. */
    this.texture.colorSpace = THREE.NoColorSpace;

    this.resize();

    /* A raster taken before the webfont resolves is a raster of the fallback
       face, at different metrics. Re-run once the real face is in. */
    if (document.fonts) {
      void document.fonts.ready.then(() => {
        if (!this.disposed) this.rebuild();
      });
    }
  }

  /**
   * Re-size to whatever the renderer is currently drawing into, and repaint.
   * Takes no dimensions: the renderer is the single source of truth for them,
   * which is the entire point.
   */
  resize(): void {
    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.canvas.width = this.bufferSize.x;
    this.canvas.height = this.bufferSize.y;

    /* Per-axis, because the two scales are not always equal: at 996x994 and
       DPR 1.25 the buffer is 1245x1242, which is 1.2500 across and 1.2495
       down. A single averaged scale would drift the bottom of the page. */
    this.scaleX = this.bufferSize.x / window.innerWidth;
    this.scaleY = this.bufferSize.y / window.innerHeight;

    this.rebuild();
  }

  /** Repaint from the DOM as it is laid out right now. */
  rebuild(): void {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    /* One transform for the whole pass, so every measured CSS pixel below is
       used verbatim without a stray multiply at each call site. */
    ctx.scale(this.scaleX, this.scaleY);

    this.paintElement(this.root);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
  }

  /* Painting ─────────────────────────────────────────────────────────── */

  private paintElement(el: Element): void {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;

    if (el instanceof HTMLImageElement) {
      this.paintImage(el, cs);
      return;
    }

    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (!WHITESPACE.test(text)) this.paintTextNode(node as Text, el, cs);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        this.paintElement(node as Element);
      }
    }
  }

  private paintImage(img: HTMLImageElement, cs: CSSStyleDeclaration): void {
    if (!img.complete || img.naturalWidth === 0) return;
    const r = img.getBoundingClientRect();
    const { ctx } = this;

    ctx.save();
    /* Canvas2D accepts the CSS filter grammar verbatim, so brightness and
       contrast do not have to be re-derived as pixel maths. */
    if (cs.filter && cs.filter !== 'none') ctx.filter = cs.filter;

    /* object-fit: cover. Scale by whichever axis needs the most, then centre
       the overflow. Anything else letterboxes and the plate crops wrong. */
    const scale = Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;

    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();
    ctx.drawImage(img, r.left + (r.width - dw) / 2, r.top + (r.height - dh) / 2, dw, dh);
    ctx.restore();
  }

  private paintTextNode(node: Text, owner: Element, cs: CSSStyleDeclaration): void {
    const { ctx } = this;
    const text = node.textContent ?? '';

    ctx.save();
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    this.applyTextShadow(cs);

    if (cs.writingMode !== 'horizontal-tb') {
      this.paintVertical(node, owner, cs);
      ctx.restore();
      return;
    }

    /* Letter-spacing is already baked into the measured per-character boxes.
       Setting it here as well would apply it twice. */
    ctx.letterSpacing = '0px';

    const range = document.createRange();
    for (let i = 0; i < text.length; i++) {
      const chr = text[i];
      if (chr === ' ' || chr === '\n' || chr === '\t') continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const box = range.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;

      /* The measured box is the character's line box. Its baseline sits an
         ascent below the box top, and the browser centres the text within
         the leading, so half the difference between the box height and the
         font's own height is the extra lead above the ascent. */
      const m = ctx.measureText(chr);
      const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent;
      const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent;
      const lead = (box.height - (ascent + descent)) / 2;
      ctx.fillText(chr, box.left, box.top + lead + ascent);
    }
    range.detach();
    ctx.restore();
  }

  /**
   * Vertical writing mode. Latin runs in `vertical-rl` are rotated a quarter
   * turn clockwise, so the run is drawn once as a rotated string rather than
   * per character: the measured boxes describe post-rotation positions, and
   * recovering the pre-rotation baseline from them costs more than it buys
   * on a single short credit line.
   */
  private paintVertical(node: Text, owner: Element, cs: CSSStyleDeclaration): void {
    const { ctx } = this;
    const r = owner.getBoundingClientRect();
    const text = (node.textContent ?? '').trim();

    ctx.translate(r.left + r.width / 2, r.top + r.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
  }

  /**
   * CSS `text-shadow` mapped onto the Canvas2D shadow slots. Both define
   * blur as twice the Gaussian standard deviation, so the radius carries
   * across unscaled. Only the first shadow in a list is honoured; this page
   * declares one.
   */
  private applyTextShadow(cs: CSSStyleDeclaration): void {
    const shadow = cs.textShadow;
    if (!shadow || shadow === 'none') return;

    const colorMatch = shadow.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i);
    const nums = shadow.match(/-?[\d.]+px/g);
    if (!colorMatch || !nums || nums.length < 2) return;

    const { ctx } = this;
    ctx.shadowColor = colorMatch[0];
    ctx.shadowOffsetX = parseFloat(nums[0]);
    ctx.shadowOffsetY = parseFloat(nums[1]);
    ctx.shadowBlur = nums.length > 2 ? parseFloat(nums[2]) : 0;
  }
}
