const API_BASE = 'https://api.openverse.org/v1/';
const MAX_ANONYMOUS_PAGE_SIZE = 20;

export type OpenverseOrientation = 'any' | 'landscape' | 'portrait' | 'square';
export type OpenverseLicense = 'all' | 'commercial' | 'modification';

export interface OpenverseImage {
  id: string;
  title: string;
  width: number | null;
  height: number | null;
  imageUrl: string;
  thumbnailUrl: string;
  landingUrl: string;
  creator: string | null;
  creatorUrl: string | null;
  license: string;
  licenseVersion: string | null;
  licenseUrl: string | null;
  provider: string;
  source: string;
  attribution: string;
}

interface OpenverseImageResponse {
  id: string;
  title: string | null;
  width: number | null;
  height: number | null;
  url: string;
  thumbnail: string;
  foreign_landing_url: string;
  creator: string | null;
  creator_url: string | null;
  license: string;
  license_version: string | null;
  license_url: string | null;
  provider: string;
  source: string;
  attribution: string | null;
}

interface SearchResponse {
  result_count: number;
  page_count: number;
  page_size: number;
  page: number;
  results: OpenverseImageResponse[];
}

export interface OpenverseSearchResult {
  total: number;
  totalPages: number;
  page: number;
  images: OpenverseImage[];
}

function mapImage(image: OpenverseImageResponse): OpenverseImage {
  const title = image.title?.trim() || 'Openverse image';
  const creator = image.creator?.trim() || null;
  const licenseName = formatLicense(image.license, image.license_version);
  return {
    id: image.id,
    title,
    width: image.width,
    height: image.height,
    imageUrl: image.url,
    thumbnailUrl: image.thumbnail,
    landingUrl: image.foreign_landing_url,
    creator,
    creatorUrl: image.creator_url,
    license: image.license,
    licenseVersion: image.license_version,
    licenseUrl: image.license_url,
    provider: image.provider,
    source: image.source,
    attribution: image.attribution || `"${title}"${creator ? ` by ${creator}` : ''} is licensed under ${licenseName}.`,
  };
}

function formatLicense(license: string, version: string | null): string {
  const normalized = license.toUpperCase().replace(/^CC0$/, 'CC0').replace(/^PDM$/, 'Public Domain Mark');
  return version ? `${normalized} ${version}` : normalized;
}

function isProbablyImage(response: Response): boolean {
  return response.ok && (response.headers.get('content-type') ?? '').startsWith('image/');
}

async function apiFetch<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    let message = `Openverse request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function searchOpenverseImages(
  query: string,
  options: {
    page?: number;
    pageSize?: number;
    orientation?: OpenverseOrientation;
    license?: OpenverseLicense;
  } = {},
): Promise<OpenverseSearchResult> {
  const pageSize = Math.max(1, Math.min(MAX_ANONYMOUS_PAGE_SIZE, options.pageSize ?? 18));
  const data = await apiFetch<SearchResponse>('images/', {
    q: query,
    page: options.page ?? 1,
    page_size: pageSize,
    mature: 'false',
    aspect_ratio: aspectRatioParam(options.orientation ?? 'any'),
    license_type: options.license && options.license !== 'all' ? options.license : undefined,
  });
  return {
    total: data.result_count,
    totalPages: data.page_count,
    page: data.page,
    images: data.results.map(mapImage),
  };
}

function aspectRatioParam(orientation: OpenverseOrientation): string | undefined {
  if (orientation === 'landscape') return 'wide';
  if (orientation === 'portrait') return 'tall';
  if (orientation === 'square') return 'square';
  return undefined;
}

export async function fetchOpenverseImageBlob(image: OpenverseImage): Promise<{ blob: Blob; source: 'image' | 'thumbnail' }> {
  try {
    const response = await fetch(image.imageUrl, { mode: 'cors' });
    if (isProbablyImage(response)) return { blob: await response.blob(), source: 'image' };
  } catch {
    // Many indexed source hosts do not allow browser CORS; fall back to Openverse thumbnail.
  }

  const thumbnail = await fetch(image.thumbnailUrl, { mode: 'cors' });
  if (!isProbablyImage(thumbnail)) throw new Error('Could not fetch this Openverse image.');
  return { blob: await thumbnail.blob(), source: 'thumbnail' };
}

export function openverseImageLabel(image: OpenverseImage): string {
  const creator = image.creator ? ` by ${image.creator}` : '';
  return `${image.title}${creator}`;
}

export function openverseLicenseLabel(image: OpenverseImage): string {
  return formatLicense(image.license, image.licenseVersion);
}
