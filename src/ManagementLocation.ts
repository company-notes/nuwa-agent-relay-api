import { APIError } from './HTTP';

export class ManagementLocation {
  static readonly sections = ['wake', 'session-replies', 'identity-reset'] as const;
  static readonly origin = 'https://agent-relay.company-notes.com';
  static readonly callbackURI = ManagementLocation.origin + '/manage/callback';

  static isPage(path: string): boolean {
    return path === '/manage' || path === '/manage/' ||
      ManagementLocation.sections.some((section) => path === '/manage/' + section);
  }

  static target(section: string, policyID: string | null): string {
    if (!ManagementLocation.sections.some((value) => value === section) ||
        (policyID !== null && (section !== 'session-replies' || !/^[a-f0-9-]{36}$/.test(policyID)))) {
      throw new APIError(400, 'invalid_management_destination', 'Unknown management destination.');
    }

    return '/manage/' + section + (policyID ? '?collaboration=' + encodeURIComponent(policyID) : '');
  }

  static collaborationURL(policyID: string): string {
    return ManagementLocation.origin + '/manage/session?section=session-replies&collaboration=' +
      encodeURIComponent(policyID);
  }
}
