import path from 'node:path';

export function getProtoPath(): string {
  if (process.env['APP_ROOT'] !== undefined) {
    return path.join(process.env['APP_ROOT'], 'electron', 'asr', 'protos', 'riva_asr.proto');
  }
  return path.join(process.resourcesPath, 'protos', 'riva_asr.proto');
}
