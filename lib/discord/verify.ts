import nacl from "tweetnacl";

function hexToBytes(value: string) {
  return new Uint8Array(Buffer.from(value, "hex"));
}

export function verifyDiscordRequest({
  body,
  signature,
  timestamp,
  publicKey,
}: {
  body: string;
  signature: string;
  timestamp: string;
  publicKey: string;
}) {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + body),
      hexToBytes(signature),
      hexToBytes(publicKey),
    );
  } catch {
    return false;
  }
}