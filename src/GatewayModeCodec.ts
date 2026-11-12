import { APIError } from './HTTP';

export enum GatewayThreadMode {
  Explicit = 1,
  Platform = 2,
}

export enum GatewayFirstContactMode {
  Manual = 1,
  Automatic = 2,
}

export enum GatewayFirstContactStatus {
  Pending = 1,
  Completed = 2,
}

/** Keep integer states inside the service and textual names at HTTP/D1 boundaries. */
export class GatewayModeCodec {
  private static readonly threadModes = new Map<string, GatewayThreadMode>([
    ['explicit', GatewayThreadMode.Explicit],
    ['platform', GatewayThreadMode.Platform],
  ]);

  private static readonly firstContactModes = new Map<string, GatewayFirstContactMode>([
    ['manual', GatewayFirstContactMode.Manual],
    ['automatic', GatewayFirstContactMode.Automatic],
  ]);

  private static readonly firstContactStatuses = new Map<string, GatewayFirstContactStatus>([
    ['pending', GatewayFirstContactStatus.Pending],
    ['completed', GatewayFirstContactStatus.Completed],
  ]);

  private static readMode<T extends number>(
    names: Map<string, T>, text: string, errorCode: string,
  ): T {
    const value = names.get(text);

    if (value === undefined) {
      throw new APIError(400, errorCode, 'Unsupported Gateway mode or state.');
    }

    return value;
  }

  private static writeMode<T extends number>(
    names: Map<string, T>, mode: T, errorCode: string,
  ): string {
    for (const [name, value] of names) {
      if (value === mode) {
        return name;
      }
    }

    throw new APIError(500, errorCode, 'Gateway mode or state is invalid.');
  }

  static readThreadMode(text: string): GatewayThreadMode {
    return this.readMode(this.threadModes, text, 'invalid_gateway_mode');
  }

  static writeThreadMode(mode: GatewayThreadMode): string {
    return this.writeMode(this.threadModes, mode, 'gateway_route_invalid');
  }

  static readFirstContactMode(text: string): GatewayFirstContactMode {
    return this.readMode(this.firstContactModes, text, 'invalid_gateway_first_contact');
  }

  static writeFirstContactMode(mode: GatewayFirstContactMode): string {
    return this.writeMode(this.firstContactModes, mode, 'gateway_route_invalid');
  }

  static readFirstContactStatus(text: string): GatewayFirstContactStatus {
    return this.readMode(this.firstContactStatuses, text, 'gateway_first_contact_state_invalid');
  }
}
