import type { Address, AddressStatus } from './AddressClient';
import { APIError } from './HTTP';

export class IdentityContext {
  readonly organization: NonNullable<AddressStatus['organization']>;
  readonly work: Address;
  readonly host: Address;

  constructor(status: AddressStatus) {
    if (!status.organization || !status.work) {
      throw new APIError(409, 'work_identity_required', 'Claim a work identity through Agent Address first.');
    }

    const host = status.hosts.find((candidate) => candidate.id === status.work?.parentAddressId);

    if (!host) {
      throw new APIError(409, 'host_identity_required', 'Work identity does not have an active host.');
    }

    if (status.work.org !== status.organization.slug || host.org !== status.organization.slug) {
      throw new APIError(403, 'wrong_organization', 'Identity is outside the authenticated organization.');
    }

    this.organization = status.organization;
    this.work = status.work;
    this.host = host;
  }

  requireSameOrganization(address: Address): Address {
    if (address.org !== this.organization.slug) {
      throw new APIError(403, 'cross_organization_unsupported', 'Cross-organization delivery is not enabled.');
    }

    return address;
  }
}
