import type { Env } from './Env';
import { APIError } from './HTTP';

export type Address = {
  id: string;
  org: string;
  path: string;
  address: string;
  canonical: string;
  parentAddressId: string | null;
};

export type AddressStatus = {
  organization: { id: string; slug: string } | null;
  hosts: Address[];
  work: Address | null;
};

export class AddressClient {
  constructor(
    private readonly env: Env,
    private readonly authorization: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.env.ADDRESS_API_URL}${path}`, {
      headers: { authorization: this.authorization },
    });
    const payload = await response.json() as {
      ok?: boolean;
      data?: T;
      error?: { message?: string };
    };

    if (!response.ok || !payload.ok || !payload.data) {
      const status = [401, 403, 404].includes(response.status)
        ? response.status
        : 502;
      throw new APIError(status, 'address_lookup_failed', payload.error?.message ?? 'Agent Address request failed.');
    }

    return payload.data;
  }

  getStatus(workAddressId?: string): Promise<AddressStatus> {
    const query = workAddressId ? `?work_address_id=${encodeURIComponent(workAddressId)}` : '';

    return this.get<AddressStatus>(`/v1/account/status${query}`);
  }

  resolve(address: string): Promise<Address> {
    return this.get<Address>(`/v1/account/resolve?address=${encodeURIComponent(address)}`);
  }
}
