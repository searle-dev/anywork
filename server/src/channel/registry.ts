import type { Channel } from "./types";

const channels = new Map<string, Channel>();

export function registerChannel(channel: Channel): void {
  channels.set(channel.type, channel);
}

export function getChannel(type: string): Channel | undefined {
  return channels.get(type);
}

export function getAllChannels(): Channel[] {
  return Array.from(channels.values());
}
