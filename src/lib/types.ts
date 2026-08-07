export interface CardFormData {
  name: string;
  dob: string;
  iss: string;
  exp: string;
  address: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutMap = Partial<Record<keyof CardFormData, BoundingBox>>;

export interface GenerateRequest {
  image: string;
  fields: CardFormData;
  layout: LayoutMap;
  enhanceClarity: boolean;
}

export interface GenerateResponse {
  success: boolean;
  image?: string;
  error?: string;
}

export interface RateLimitState {
  count: number;
  resetAt: number;
}
