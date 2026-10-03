import type { StartupImage, StoredImageReference, StoredImageSlot } from 'stusign';
import type { RgbaImage } from 'stusign/protocol';
import { imageFromCanvas } from 'stusign/render';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const width = 800,
  height = 480;

type ConnectionPreference = {
  enabled: boolean;
  source: 'upload' | 'stored';
  png?: string;
};

async function readPreview(png: unknown): Promise<RgbaImage> {
  if (
    typeof png !== 'string' ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) ||
    png.length > 2_500_000
  )
    throw new Error('The remembered image is invalid. Prepare and save an image again.');
  const bytes = Uint8Array.from(atob(png.split(',')[1]!), (c) => c.charCodeAt(0));
  return fitImage(new Blob([bytes], { type: 'image/png' }));
}

function imageCanvas(image?: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (image)
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), 0, 0);
  return canvas;
}

function welcomeCard(): RgbaImage {
  const canvas = imageCanvas(),
    context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#28664c';
  context.fillRect(0, 0, width, 16);
  context.fillRect(48, 368, 704, 2);
  context.font = 'bold 24px sans-serif';
  context.fillText('STUSIGN', 48, 86);
  context.fillStyle = '#203129';
  context.font = 'bold 64px sans-serif';
  context.fillText('Welcome.', 48, 220);
  context.font = '26px sans-serif';
  context.fillText('Please wait for your document.', 48, 280);
  context.font = '18px sans-serif';
  context.fillText('800 × 480 · STU-540', 48, 418);
  return imageFromCanvas(canvas);
}

async function fitImage(blob: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = imageCanvas(),
      context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
    return imageFromCanvas(canvas);
  } finally {
    bitmap.close();
  }
}

/** Local image preparation and a remembered reference; never talks to the tablet. */
export class WelcomePanel {
  image = welcomeCard();
  loading = false;
  private saved: { reference: StoredImageReference; image: RgbaImage } | undefined;
  private readonly key: string;

  constructor(
    simulated: boolean,
    private readonly changed: () => void,
  ) {
    this.key = `stusign.welcome.v1.${simulated ? 'simulation' : 'hardware'}`;
    element<HTMLInputElement>('welcome-auto').checked = false;
    element<HTMLSelectElement>('welcome-startup').value = 'upload';
    this.render();
    element('welcome-file').addEventListener('change', () => {
      const file = element<HTMLInputElement>('welcome-file').files?.[0];
      if (!file) return;
      void this.prepare(async () => {
        if (
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
          file.size > 32 * 1024 * 1024
        )
          throw new Error('Choose a PNG, JPEG or WebP image smaller than 32 MB.');
        this.image = await fitImage(file);
        this.render();
        this.notice('Image prepared locally. Preview it on the tablet before saving.');
        this.persist();
      });
    });
    element('welcome-default').addEventListener('click', () => {
      this.image = welcomeCard();
      element<HTMLInputElement>('welcome-file').value = '';
      this.render();
      this.notice('Default welcome card prepared. No tablet image has changed.');
      this.persist();
    });
    element('welcome-kind').addEventListener('change', () => {
      const input = element<HTMLInputElement>('welcome-number');
      input.max = element<HTMLSelectElement>('welcome-kind').value === 'message' ? '6' : '10';
      if (Number(input.value) > Number(input.max)) input.value = input.max;
    });
    for (const id of ['welcome-auto', 'welcome-startup']) {
      element(id).addEventListener('change', () => {
        this.persist();
        this.changed();
      });
    }
  }

  private notice(text: string): void {
    element('welcome-status').textContent = text;
  }
  private render(): void {
    const canvas = element<HTMLCanvasElement>('welcome-preview');
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(this.image.data), width, height), 0, 0);
  }
  private async prepare(work: () => Promise<void>): Promise<void> {
    this.loading = true;
    this.changed();
    try {
      await work();
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Could not prepare image.');
    } finally {
      this.loading = false;
      this.changed();
    }
  }
  setDisabled(disabled: boolean): void {
    for (const input of document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >('[data-welcome-option]'))
      input.disabled = disabled || this.loading;
    const source = element<HTMLSelectElement>('welcome-startup');
    source.disabled =
      disabled || this.loading || !element<HTMLInputElement>('welcome-auto').checked;
    source.querySelector<HTMLOptionElement>('option[value="stored"]')!.disabled = !this.saved;
  }
  get slot(): StoredImageSlot {
    const kind = element<HTMLSelectElement>('welcome-kind').value;
    const number = element<HTMLInputElement>('welcome-number').valueAsNumber;
    if (
      (kind !== 'slideshow' && kind !== 'message') ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > (kind === 'message' ? 6 : 10)
    )
      throw new Error('Select a slideshow slot from 1–10 or a message slot from 1–6.');
    return { kind, number };
  }
  stored(): { reference: StoredImageReference; image: RgbaImage } {
    const slot = this.slot;
    if (
      !this.saved ||
      this.saved.reference.slot.kind !== slot.kind ||
      this.saved.reference.slot.number !== slot.number
    )
      throw new Error(
        'Save an image to the selected slot first, or select the previously saved slot shown below.',
      );
    return this.saved;
  }
  startup(): StartupImage | undefined {
    const source = this.connectionSource();
    if (source === 'upload') return { source, image: this.image, format: 'bgr24' };
    if (source === 'stored') {
      if (!this.saved)
        throw new Error('Save an image to the tablet before enabling stored recall.');
      const { reference } = this.saved;
      return { source, slot: reference.slot, expectedHash: reference.hash };
    }
    return undefined;
  }
  connectionExpectation(): string {
    switch (this.connectionSource()) {
      case 'upload':
        return 'The prepared welcome image should appear and match the preview. A full image is sent on each connection.';
      case 'stored':
        return 'The saved welcome image should appear and match the preview. Its hash is checked and the slot recalled without sending image pixels.';
      default:
        return 'After the tablet finishes booting, this connection should leave its display unchanged.';
    }
  }
  connectionPreview(): RgbaImage | undefined {
    switch (this.connectionSource()) {
      case 'upload':
        return this.image;
      case 'stored':
        return this.saved?.image;
      default:
        return undefined;
    }
  }
  private connectionSource(): ConnectionPreference['source'] | undefined {
    if (!element<HTMLInputElement>('welcome-auto').checked) return undefined;
    return element<HTMLSelectElement>('welcome-startup').value === 'stored' ? 'stored' : 'upload';
  }
  private describeConnection(): void {
    const source = this.connectionSource();
    element('welcome-connection-status').textContent =
      source === 'stored'
        ? 'On. The last saved image will be recalled on every app connection, without transferring pixels. Remembered in this browser.'
        : source === 'upload'
          ? 'On. The prepared image will be uploaded on every app connection. The image and this choice are remembered in this browser.'
          : 'Off. No welcome image is sent on connect. Background restore is configured separately. This choice is remembered in this browser.';
  }
  remember(reference: StoredImageReference, image: RgbaImage): void {
    this.saved = { reference, image };
    this.describeSaved();
    if (!element<HTMLInputElement>('welcome-auto').checked)
      element<HTMLSelectElement>('welcome-startup').value = 'stored';
    this.notice('Saved in the tablet. The slot, hash and preview are available for recall.');
    this.persist();
  }
  private persist(): void {
    try {
      const source = element<HTMLSelectElement>('welcome-startup')
        .value as ConnectionPreference['source'];
      const enabled = element<HTMLInputElement>('welcome-auto').checked;
      const connection: ConnectionPreference = { enabled, source };
      if (enabled && source === 'upload')
        connection.png = imageCanvas(this.image).toDataURL('image/png');
      const saved = this.saved;
      localStorage.setItem(
        this.key,
        JSON.stringify({
          ...(saved
            ? {
                slot: saved.reference.slot,
                hash: Array.from(saved.reference.hash),
                png: imageCanvas(saved.image).toDataURL('image/png'),
              }
            : {}),
          connection,
        }),
      );
      this.describeConnection();
    } catch {
      element('welcome-connection-status').textContent =
        'Browser storage could not be updated. Your current choice and image work for this page session; reloading will use the previously remembered choice, if any.';
    }
  }
  private describeSaved(): void {
    if (!this.saved) return;
    const { slot, hash } = this.saved.reference;
    element('welcome-saved').textContent =
      `Remembered image: ${slot.kind} ${slot.number} · hash ${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  async restore(): Promise<void> {
    await this.prepare(async () => {
      const raw = localStorage.getItem(this.key);
      if (!raw) return;
      const value = JSON.parse(raw) as {
        slot?: StoredImageSlot;
        hash?: number[];
        png?: string;
        connection?: ConnectionPreference;
      } | null;
      if (!value || typeof value !== 'object')
        throw new Error('The remembered welcome settings are invalid.');
      const slot = value.slot;
      if (slot !== undefined || value.hash !== undefined || value.png !== undefined) {
        if (
          !slot ||
          (slot.kind !== 'slideshow' && slot.kind !== 'message') ||
          !Number.isInteger(slot.number) ||
          slot.number < 1 ||
          slot.number > (slot.kind === 'message' ? 6 : 10) ||
          !Array.isArray(value.hash) ||
          value.hash.length !== 16 ||
          !value.hash.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
        )
          throw new Error('The remembered image is invalid. Prepare and save an image again.');
        this.image = await readPreview(value.png);
        this.saved = { reference: { slot, hash: Uint8Array.from(value.hash) }, image: this.image };
        element<HTMLSelectElement>('welcome-kind').value = slot.kind;
        const number = element<HTMLInputElement>('welcome-number');
        number.max = slot.kind === 'message' ? '6' : '10';
        number.value = String(slot.number);
        this.describeSaved();
        this.render();
        element<HTMLSelectElement>('welcome-startup').value = 'stored';
      }
      const connection = value.connection;
      if (connection !== undefined) {
        if (
          !connection ||
          typeof connection.enabled !== 'boolean' ||
          (connection.source !== 'upload' && connection.source !== 'stored') ||
          (connection.enabled && connection.source === 'stored' && !this.saved)
        )
          throw new Error(
            'The remembered connection choice is invalid. Automatic display remains off.',
          );
        if (connection.enabled && connection.source === 'upload')
          this.image = await readPreview(connection.png);
        element<HTMLSelectElement>('welcome-startup').value = connection.source;
        element<HTMLInputElement>('welcome-auto').checked = connection.enabled;
      }
      this.render();
      this.describeConnection();
      this.notice(
        'Remembered welcome settings loaded. Stored images are hash-checked before recall.',
      );
    });
  }
}
