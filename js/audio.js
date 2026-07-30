function AudioHandler() {

  this.hasAudio = true;
  this.workletReady = Promise.reject(new Error("AudioWorklet not initialized"));
  this.workletReady.catch(function() {});
  let Ac = window.AudioContext || window.webkitAudioContext;
  this.sampleBuffer = new Float64Array(735);
  this.samplesPerFrame = 735;

  if(Ac === undefined) {
    log("Audio disabled: no Web Audio API support");
    this.hasAudio = false;
  } else {
    this.actx = new Ac({sampleRate: 11025});

    let samples = Math.floor(this.actx.sampleRate / 60);
    this.sampleBuffer = new Float64Array(samples);
    this.samplesPerFrame = samples;

    log("Audio initialized, sample rate: " + this.actx.sampleRate);

    this.inputBuffer = new Float64Array(4096);
    this.inputBufferPos = 0;
    this.inputReadPos = 0;

    this.scriptNode = undefined;
    this.workletNode = undefined;
  }

  this.resume = function() {
    // for Chrome autoplay policy
    if(this.hasAudio) {
      this.actx.onstatechange = () => { console.log(this.actx.state); };
      this.actx.resume();
      if(this.actx.audioWorklet) {
        this.workletReady = this.actx.audioWorklet.addModule('js/audio-worklet-processor.js');
      } else {
        this.workletReady = Promise.reject(new Error("AudioWorklet not supported"));
        this.workletReady.catch(function() {});
      }
    }
  }

  this.start = async function() {
    if(this.hasAudio) {
      try {
        await this.workletReady;
        if(this.scriptNode) {
          this.scriptNode.disconnect();
          this.scriptNode.onaudioprocess = null;
          this.scriptNode = undefined;
        }
        if(!this.workletNode) {
          this.workletNode = new AudioWorkletNode(this.actx, "nes-audio-processor");
          this.workletNode.connect(this.actx.destination);
        }
      } catch(e) {
        if(!this.scriptNode) {
          this.scriptNode = this.actx.createScriptProcessor(2048, 1, 1);
          let that = this;
          this.scriptNode.onaudioprocess = function(e) {
            that.process(e);
          }
          this.scriptNode.connect(this.actx.destination);
        }
      }
    }
  }

  this.stop = function() {
    if(this.hasAudio) {
      if(this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = undefined;
      }
      if(this.scriptNode) {
        this.scriptNode.disconnect();
        this.scriptNode.onaudioprocess = null;
        this.scriptNode = undefined;
      }
      this.inputBufferPos = 0;
      this.inputReadPos = 0;
    }
  }

  this.process = function(e) {
    if(this.inputReadPos + 2048 > this.inputBufferPos) {
      // we overran the buffer
      //log("Audio buffer overran");
      this.inputReadPos = this.inputBufferPos - 2048;
    }
    if(this.inputReadPos + 4096 < this.inputBufferPos) {
      // we underran the buffer
      //log("Audio buffer underran");
      this.inputReadPos += 2048;
    }
    let output = e.outputBuffer.getChannelData(0);
    for(let i = 0; i < 2048; i++) {
      output[i] = this.inputBuffer[(this.inputReadPos++) & 0xfff];
    }
  }

  this.nextBuffer = function() {
    if(this.hasAudio) {
      if(this.workletNode) {
        let samples = new Float32Array(this.sampleBuffer);
        this.workletNode.port.postMessage(samples, [samples.buffer]);
      } else {
        for(let i = 0; i < this.samplesPerFrame; i++) {
          let val = this.sampleBuffer[i];
          this.inputBuffer[(this.inputBufferPos++) & 0xfff] = val;
        }
      }
    }
  }
}
