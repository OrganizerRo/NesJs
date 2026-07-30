class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.bufferSize = 8192;
    this.sampleBuffer = new Float32Array(this.bufferSize);
    this.readPointer = 0;
    this.writePointer = 0;
    this.bufferedSamples = 0;

    this.port.onmessage = (event) => {
      let samples = event.data;
      if(!(samples instanceof Float32Array)) {
        return;
      }

      for(let i = 0; i < samples.length; i++) {
        this.sampleBuffer[this.writePointer] = samples[i];
        this.writePointer = (this.writePointer + 1) & (this.bufferSize - 1);
        if(this.bufferedSamples < this.bufferSize) {
          this.bufferedSamples++;
        } else {
          this.readPointer = (this.readPointer + 1) & (this.bufferSize - 1);
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    let output = outputs[0][0];
    if(!output) {
      return true;
    }

    for(let i = 0; i < output.length; i++) {
      if(this.bufferedSamples > 0) {
        output[i] = this.sampleBuffer[this.readPointer];
        this.readPointer = (this.readPointer + 1) & (this.bufferSize - 1);
        this.bufferedSamples--;
      } else {
        output[i] = 0;
      }
    }

    return true;
  }
}

registerProcessor("nes-audio-processor", NesAudioProcessor);
