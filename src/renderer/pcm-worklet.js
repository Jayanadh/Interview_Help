/**
 * Converts the graph's Float32 audio into 40 ms frames of 16-bit PCM.
 *
 * 40 ms at 24 kHz = 960 samples = 1920 bytes. Deepgram wants 20-250 ms
 * frames; smaller would just mean more IPC traffic for no latency win,
 * since the network round trip dominates anything under ~50 ms.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.len = 0;
    this.frame = 960;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    if (this.len + ch.length > this.buf.length) {
      const bigger = new Float32Array(this.buf.length * 2);
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(ch, this.len);
    this.len += ch.length;

    while (this.len >= this.frame) {
      const pcm = new Int16Array(this.frame);
      for (let i = 0; i < this.frame; i++) {
        const s = Math.max(-1, Math.min(1, this.buf[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      this.buf.copyWithin(0, this.frame, this.len);
      this.len -= this.frame;
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
