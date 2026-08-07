export interface CardFormData {
  name: string;
  dob: string;
  iss: string;
  exp: string;
  address: string;
}

export interface GenerateRequest {
  image: string;
  fields: CardFormData;
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
