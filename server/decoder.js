// SPDX-License-Identifier: AGPL-3.0-or-later AND MIT
// Copyright (C) 2026 imanuk and contributors. See LICENSE and NOTICE.md.
// Derived in part from coloradoScoreboard by Fabrizio Bertocci (MIT) - see NOTICE.md.
// VERSION: 2.0.0 - v2: added 'data' passthrough + 'close' event for serialSupervisor.js reconnect/staleness handling
console.log('decoder.js VERSION 2.0.0 loaded');

/*
 * This is a crude but functional implementation of reading Colorado Time Systems Gen7/WA-2 
 * protocol data off of a serial port. This implementation only supports Swimming data and not other event types that the Gen7 can time.
 * The data stream from a Gen7 Serial timer console via RS-485 is much different than the previous
 * CTS RS-232 data streams from previous generation CTS timers.
 * You can create your own RS-485 to USB serial cable using the following parts:
 *      CONXALL/SWITCHCRAFT P/N 3280-4PG-315  Male plug end  https://www.switchcraft.com/multi-con-x-connectors-0-875-od/multiconx/
 *      FTDI USB-RS485-WE-1800-BT  USB to RS-485 converter  https://ftdichip.com/products/usb-rs485-we-1800-bt/
 *      
 *      ** Wiring for the CTS Gen7 RS-485 socket to the FTDI USB-RS485-WE-1800-BT is as follows, unreferenced wires are trimmed and not used **
 *      BLACK (GND) -> Pin 4
 *      Yellow (Data-) -> Pin 3
 *      Orange (Data+) -> Pin 2
 *      
 *      Below is a ascii drawing of the CTS Gen7 female RS-485 socket pinout as viewed from the back of the timer console, you will be wiring the Male Plug
 *      to the correpsonding pins of the FEMALE socket when the male plug is properly keyed and latched into the socket.
 
 *      TOP 
 *   .---v---.
   /           \
  |   o 1   o 4 |
  |             |
  |   o 2   o 3 |
   \           /
     '-------'
 
     The following is AI generated code commentary, take it as it is...
- Use EventEmitter to expose events: EventChange, HeatChange, ScoreboardReset, ScoreboardStart, ScoreboardBlank, ScoreboardBlankWithTime.
- Use 'serialport' package (user should install separately) for serial communication.
- Represent data structures:
  - Lane: { number, lastName, firstName, team, property change not necessary }
  - Heat: array of 12 Lane objects + HasGen7Data flag
  - SwimmingEvent: { Heats: Map<number, Heat>, EventTitle, Records, HasGen7Data }
  - Meet: { MeetTitle, Events: Map<number, SwimmingEvent>, RecordTags, HasGen7Data }
  - ScoreboardDigitEnhanced: { value, decPoint, segmentMapped, updated }
  - ScoreboardModuleEnhanced: { univ, horn, moduleData[31] }
  - EnhancedScoreboard: { boardData[31], BlankState logic }
- Implement mapping / remapping algorithm:
  - Initialize a 32-entry _mappings array from concatenated hex strings as in C# static constructor.
  - Implement rotateLeft32/rotateRight32 and getLowest7F helpers for 32-bit ops.
  - Keep a per-instance mapper state similar to C# for incoming stream and a static RemapByte overload that accepts state (for non-checksum remapping).
- Implement serial parsing state machine:
  - Buffer incoming bytes, detect packet start (byte with 0x80 bit).
  - Follow logic: waitingOnLength, inPacket, incomingData array, checksum calculation, then extract payload bytes remapped and feed ParseEnhancedByte.
- Implement ParseEnhancedByte similar to C#:
  - Maintain currentModule, dataByte1, currentDigit, inCommand, _inModuleCommand, moduleCommandData.
  - Update scbd[poolNumber].BoardData[module].ModuleData[digit] fields.
  - On module 12 parse event/heat digits and emit EventChange/HeatChange as needed.
  - Parse non-module commands (cmd id 18) to populate Gen7SwimmingData (MeetTitle, start list event/heat, swimmer names/teams) using UTF-8 decoding similar to SubStringUTF8 logic.
- Implement helpers:
  - DataToChar: map 0/15 to space, otherwise char from code.
  - GetDigit, GetTime, GetDigits, DecPointLit, ResetDotsLit and BlankState logic mapping using EnhancedScoreboard methods.
- Provide openPort and close methods; if portName invalid do not open.
- Expose minimal console demo method `printDemo()` that mirrors the selected C# console loop: prints Event/Heat, MeetTitle, EventTitle, and for modules 0..10 prints GetTime and swimmer name.
- Keep code synchronous where possible but serial read is event-driven.
- Comments: instruct to `npm install serialport` to operate.

*/

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

// Helpers for 32-bit rotation and masks
function rotateLeft32(x, count) {
  count &= 31;
  return ((x << count) | (x >>> (32 - count))) >>> 0;
}
function rotateRight32(x, count) {
  count &= 31;
  return ((x >>> count) | (x << (32 - count))) >>> 0;
}
function getLowest7F(x) {
  return x & 0x7F;
}

// Data structures
class Lane {
  constructor(number) {
    this._number = number;
    this.LastName = '';
    this.FirstName = '';
    this.Team = '';
  }
  get Number() {
    return this._number;
  }
  set Number(v) {
    this._number = v;
  }
}

class Heat extends Array {
  constructor() {
    super();
    this.HasGen7Data = false;
    for (let i = 0; i < 12; ++i) this.push(new Lane(i + 1));
  }
}

class SwimmingEvent {
  constructor() {
    this.Heats = new Map();
    this.EventTitle = '';
    this.Records = new Array(4).fill('');
    this.HasGen7Data = false;
  }
}

class Meet {
  constructor() {
    this.MeetTitle = '';
    this.Events = new Map();
    this.RecordTags = new Array(4).fill('');
    this.HasGen7Data = false;
  }
}

class ScoreboardDigitEnhanced {
  constructor() {
    this.Value = 15;
    this._decPoint = false;
    this.SegmentMapped = false;
    this.Updated = false;
  }
  get DecPoint() {
    return this._decPoint;
  }
  set DecPoint(v) {
    this._decPoint = !!v;
  }
}

class ScoreboardModuleEnhanced {
  constructor() {
    this.Univ = false;
    this.Horn = false;
    this.ModuleData = new Array(31);
    for (let i = 0; i < 31; ++i) this.ModuleData[i] = new ScoreboardDigitEnhanced();
  }
  get Updated() {
    return this.ModuleData.some(d => d.Updated);
  }
}

const ScoreboardState = {
  None: 0,
  NotBlank: 1,
  BlankWithTime: 2,
  TotalBlank: 3,
  Reset: 4,
  Running: 5
};

const Sport = {
  SportLoader: 0,
  Swimming: 1
};

class EnhancedScoreboard {
  constructor() {
    this.BoardData = new Array(31);
    for (let i = 0; i < 31; ++i) this.BoardData[i] = new ScoreboardModuleEnhanced();
  }
  ShowingTimeOfDay() {
    return this.BoardData[22].ModuleData[5].Value !== 15 &&
           this.BoardData[22].ModuleData[6].Value !== 15 &&
           this.BoardData[22].ModuleData[5].Value !== 32 &&
           this.BoardData[22].ModuleData[6].Value !== 32;
  }
  IsBlanked() {
    for (let i = 1; i <= 10; ++i) {
      const val = this.BoardData[i].ModuleData[1].Value;
      if (val !== 15 && val !== 32) return false;
    }
    return true;
  }
  BlankState() {
    if (!this.IsBlanked()) return ScoreboardState.NotBlank;
    return this.ShowingTimeOfDay() ? ScoreboardState.BlankWithTime : ScoreboardState.TotalBlank;
  }
}

// gen7Scbd implementation
// How long a staged swimmer burst waits for a heat change before being
// committed to the heat that's already displayed (see _stageFallbackLane).
const STAGE_QUIET_MS = 750;

class Gen7Scbd extends EventEmitter {
  constructor(portName) {
    super();

    // mapping constants
    this._mappings = new Uint32Array(32);
    this._initMappings();

    // state
    this._moduleCommandData = [];
    this._currentScoreboardState = [];
    this._currentSport = [];
    this._inModuleCommand = false;
    this._isOdd = false;
    this._mapLength = 0;
    this._mapper = 0;
    this._mappingCount = 0;
    this.calculatedChecksum = 0;
    this.currentDigit = 0;
    this.currentModule = 0;
    this.dataByte1 = true;
    this.dataCount = 0;
    this.expecetdDataCount = 0;
    this.incomingData = new Uint8Array(256);
    this.incomingReadPtr = 0;
    this.incomingWritePtr = 0;
    this.inCommand = false;
    this.inPacket = false;
    this.judge1 = '';
    this.scbd = [new EnhancedScoreboard()];
    this._timerNumber = 0;
    this.waitingOnLength = false;
    this._startListEventNumber = 0;
    this._startListHeatNumber = 0;
    this._stagedLanes = null;
    this._stagedPool = 0;
    this._stageTimer = null;
    this._previousDisplayEventNumber = 0; // track previous event to apply lookahead titles correctly
    this._pendingLaneData = []; // queue for case 3 packets arriving before case 2

    this.CurrentEventNumber = [];
    this.CurrentHeatNumber = [];
    this.CurrentSport = [];
    this.Gen7SwimmingData = [];

    // initialize for pool 0 only - additional pools are auto-created as needed
    this._initPool(0);

    // serial port
    this.portName = portName;
    this.portOpen = false;
    this.port = null;

    if (portName) {
      this.openPort();
    }
  }

  // Initialise a single pool slot - called for pool 0 at startup and
  // auto-called for any higher pool index seen in the data stream.
  _initPool(poolIdx) {
    while (this.CurrentEventNumber.length <= poolIdx) {
      this.CurrentEventNumber.push(0);
    }
    while (this.CurrentHeatNumber.length <= poolIdx) {
      this.CurrentHeatNumber.push(0);
    }
    while (this.CurrentSport.length <= poolIdx) {
      this.CurrentSport.push(Sport.SportLoader);
    }
    while (this._currentScoreboardState.length <= poolIdx) {
      this._currentScoreboardState.push(ScoreboardState.None);
    }
    while (this.Gen7SwimmingData.length <= poolIdx) {
      this.Gen7SwimmingData.push(new Meet());
    }
    while (this.scbd.length <= poolIdx) {
      this.scbd.push(new EnhancedScoreboard());
    }
    console.log(`Pool slot ${poolIdx} initialised`);
  }

  // Ensure a pool index exists before we try to use it.
  // Call this at the top of any method that indexes into pool arrays.
  _ensurePool(poolIdx) {
    if (poolIdx < 0) return;
    if (this.Gen7SwimmingData.length <= poolIdx) {
      console.log(`Auto-creating pool slot for index ${poolIdx} (session ${poolIdx + 1})`);
      this._initPool(poolIdx);
    }
  }

  _initMappings() {
    const str = "F37C65B454BD061AC3E2161EEBB26E8EEC95883E5CAB118EF3D7D3ACC6DA3754" +
                "178C9A44414B16BC351AE48C30EA2D3839F009BCBC7F3AE4DECACED82AA0D794" +
                "7A02E6B088BA6B4EA63D2E4463E1780A574169B4D0258F42023E04D0D0D19CF6" +
                "FB0805F6E18DC550B61F577EC4FAEF9C9395C310EF23508067C46C28843F4A36";
    for (let i = 0; i < 16; ++i) {
      const num = parseInt(str.substring(i * 8, i * 8 + 8), 16) >>> 0;
      this._mappings[i * 2 + 1] = num;
    }
    for (let i = 0; i < 16; ++i) {
      const num = parseInt(str.substring(128 + i * 8, 128 + i * 8 + 8), 16) >>> 0;
      this._mappings[i * 2] = num;
    }
  }

  openPort() {
    try {
      this.port = new SerialPort({
        path: this.portName,
        baudRate: 115200,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        autoOpen: false
      });

      this.port.on('data', this._onData.bind(this));
      this.port.on('error', (err) => this.emit('error', err));
      this.port.on('close', () => {
        this.portOpen = false;
        this.emit('close');
      });

      this.port.open((err) => {
        if (err) {
          this.portOpen = false;
          this.emit('error', err);
          return;
        }
        this.portOpen = true;

        const buffer = Buffer.from([0x80, 0x1F, 15, 2]);
        this.port.write(buffer, (werr) => {
          if (werr) this.emit('error', werr);
        });
      });
      return true;
    } catch (ex) {
      this.emit('error', ex);
      return false;
    }
  }

  closePort() {
    if (this.port && this.port.isOpen) {
      this.port.close();
      this.portOpen = false;
    }
  }

  SetCurrentScorboardState(poolNumber, value) {
    this._ensurePool(poolNumber);
    const prev = this._currentScoreboardState[poolNumber];
    if (value !== prev) {
      if (value === ScoreboardState.Reset) {
        this.emit('ScoreboardReset', { poolNumber });
      } else if (value === ScoreboardState.Running && prev !== ScoreboardState.None) {
        this.emit('ScoreboardStart', { poolNumber });
      } else if (value === ScoreboardState.BlankWithTime) {
        this.emit('ScoreboardBlankWithTime', { poolNumber });
      } else if (value === ScoreboardState.TotalBlank) {
        this.emit('ScoreboardBlank', { poolNumber });
      }
    }
    this._currentScoreboardState[poolNumber] = value;
  }

  DecPointLit(poolNumber, module, digit) {
    this._ensurePool(poolNumber);
    if (poolNumber < this.scbd.length && module < this.scbd[poolNumber].BoardData.length) {
      const moduleData = this.scbd[poolNumber].BoardData[module].ModuleData;
      if (digit < moduleData.length) return !!moduleData[digit].DecPoint;
    }
    return false;
  }

  ResetDotsLit(poolNumber) {
    this._ensurePool(poolNumber);
    if (poolNumber < 0 || poolNumber >= this.scbd.length) return false;
    for (let i = 1; i < 10; ++i) {
      if (this.scbd[poolNumber].BoardData[i].ModuleData[1].DecPoint) return true;
    }
    return !!this.scbd[poolNumber].BoardData[15].ModuleData[1].DecPoint;
  }

  _onData(buffer) {
    this.emit('data', buffer);
    for (let i = 0; i < buffer.length; ++i) {
      const src1 = buffer[i];
      const num1 = this._remapByte(src1);
      if (this.inPacket) {
        if ((num1 & 0x80) !== 0) {
          this.incomingWritePtr = 0;
          this.incomingData[this.incomingWritePtr++] = num1;
          this.calculatedChecksum = num1;
          this.inPacket = false;
          this.waitingOnLength = true;
        } else {
          ++this.dataCount;
          if (this.dataCount > this.expecetdDataCount) {
            this.calculatedChecksum &= 0x7F;
            if ((this.calculatedChecksum & 0xFF) === num1) {
              if (this.incomingData[this.incomingReadPtr] === 159 &&
                 (this.incomingData[this.incomingReadPtr + 1] === 17 || this.incomingData[this.incomingReadPtr + 1] === 19)) {
                const poolNumber = (this.incomingData[this.incomingReadPtr + 2] - 1) & 0xFF;
                // DIAGNOSTIC - log pool number from every packet header
                console.log(`_onData: special packet detected, raw pool byte=${this.incomingData[this.incomingReadPtr + 2]} poolNumber=${poolNumber}`);
                const src2 = (this.incomingData[this.incomingReadPtr + 3] | 0x80) & 0xFF;
                const byteList = [];
                const state = { MappingCount: 0, Mapper: 0, IsOdd: false, MapLength: 0 };
                const first = Gen7Scbd._remapByteStatic(src2, state);
                byteList.push(first);
                let num3 = first;
                for (let idx2 = 1; idx2 < this.dataCount - 4; ++idx2) {
                  const b = Gen7Scbd._remapByteStatic(this.incomingData[this.incomingReadPtr + 3 + idx2], state);
                  if (idx2 !== 1) byteList.push(b);
                  num3 = (num3 + b) & 0xFF;
                }
                const num5 = Gen7Scbd._remapByteStatic(this.incomingData[this.incomingReadPtr + this.dataCount - 1], state);
                if (((num3 & 0x7F) >>> 0) === num5) {
                  for (const inc of byteList) this.ParseEnhancedByte(inc, poolNumber);
                }
                this.incomingReadPtr = this.incomingWritePtr;
              }
              while (this.incomingReadPtr !== this.incomingWritePtr) {
                const b = this.incomingData[this.incomingReadPtr++];
                this.ParseEnhancedByte(b, 0);
              }
            } else {
              this.incomingReadPtr = this.incomingWritePtr = 0;
            }
            this.inPacket = false;
            this.waitingOnLength = false;
          } else {
            this.incomingData[this.incomingWritePtr++] = num1;
            this.calculatedChecksum = (this.calculatedChecksum + num1) & 0xFF;
          }
        }
      } else if (this.waitingOnLength) {
        this.waitingOnLength = false;
        this.inPacket = true;
        this.expecetdDataCount = num1;
        this.calculatedChecksum = (this.calculatedChecksum + num1) & 0xFF;
        this.dataCount = 0;
      } else if ((num1 & 0x80) !== 0) {
        this.incomingReadPtr = this.incomingWritePtr = 0;
        this.incomingData[this.incomingWritePtr++] = num1;
        this.calculatedChecksum = src1 & 0xFF;
        this.waitingOnLength = true;
      }
    }
  }

  _remapByte(src) {
    let num1;
    if (src > 127) {
      this._mappingCount = 0;
      num1 = src;
      this._mapper = this._mappings[src & 31];
      this._isOdd = (src % 2) === 1;
    } else if (this._mappingCount === 0) {
      this._mapLength = (src ^ (this._mapper & 0x7F)) >>> 0;
      num1 = this._mapLength & 0xFF;
      ++this._mappingCount;
    } else {
      const num2 = !this._isOdd
        ? getLowest7F(rotateLeft32(this._mapper, (this._mapLength * this._mappingCount) & 0xFFFFFFFF))
        : getLowest7F(rotateRight32(this._mapper, (this._mapLength * this._mappingCount) & 0xFFFFFFFF));
      num1 = (src ^ num2) & 0xFF;
      ++this._mappingCount;
    }
    return num1;
  }

  static _remapByteStatic(src, state) {
    let num1;
    if (src > 127) {
      state.MappingCount = 0;
      num1 = src;
      state.Mapper = this._staticMappings ? this._staticMappings[src & 31] : 0;
      if (!this._staticMappings) {
        this._staticMappings = new Uint32Array(32);
        const hex = "F37C65B454BD061AC3E2161EEBB26E8EEC95883E5CAB118EF3D7D3ACC6DA3754" +
                    "178C9A44414B16BC351AE48C30EA2D3839F009BCBC7F3AE4DECACED82AA0D794" +
                    "7A02E6B088BA6B4EA63D2E4463E1780A574169B4D0258F42023E04D0D0D19CF6" +
                    "FB0805F6E18DC550B61F577EC4FAEF9C9395C310EF23508067C46C28843F4A36";
        for (let i = 0; i < 16; ++i) this._staticMappings[i * 2 + 1] = parseInt(hex.substring(i * 8, i * 8 + 8), 16) >>> 0;
        for (let i = 0; i < 16; ++i) this._staticMappings[i * 2] = parseInt(hex.substring(128 + i * 8, 128 + i * 8 + 8), 16) >>> 0;
        state.Mapper = this._staticMappings[src & 31];
      }
      state.IsOdd = (src % 2) === 1;
    } else if (state.MappingCount === 0) {
      state.MapLength = (src ^ (state.Mapper & 0x7F)) >>> 0;
      num1 = state.MapLength & 0xFF;
      ++state.MappingCount;
    } else {
      const num2 = !state.IsOdd
        ? getLowest7F(rotateLeft32(state.Mapper, (state.MapLength * state.MappingCount) & 0xFFFFFFFF))
        : getLowest7F(rotateRight32(state.Mapper, (state.MapLength * state.MappingCount) & 0xFFFFFFFF));
      num1 = (src ^ num2) & 0xFF;
      ++state.MappingCount;
    }
    return num1;
  }

  ParseEnhancedByte(inc, poolNumber) {
    // Auto-create pool slot if the data stream references one we haven't seen yet
    this._ensurePool(poolNumber);

    if ((inc & 0x80) === 0x80) {
      if (this.currentModule === 15) {
        if (this.ResetDotsLit(poolNumber) && this.CurrentSport[poolNumber] === Sport.Swimming) {
          this.SetCurrentScorboardState(poolNumber, ScoreboardState.Reset);
        } else {
          const scoreboardState = this.scbd[poolNumber].BlankState();
          if (scoreboardState === ScoreboardState.BlankWithTime || scoreboardState === ScoreboardState.TotalBlank) {
            this.SetCurrentScorboardState(poolNumber, scoreboardState);
          } else if (this.CurrentSport[poolNumber] === Sport.Swimming) {
            this.SetCurrentScorboardState(poolNumber, ScoreboardState.Running);
          }
        }
      } else if (this.currentModule >= 1 && this.currentModule <= 10) {
        if (this.currentModule === 1) this.DetectCurrentSport(poolNumber);
      } else if (this.currentModule === 12) {
        // Read event number by collecting non-space digits from positions 1-5.
        // The display uses alternating digit/space layout (e.g. [1:2][ ][3:0][4:2])
        // so a fixed 3-position read misses digits. We skip spaces instead.
        let num1 = 0;
        try {
          let eventStr = '';
          for (let d = 1; d <= 5; d++) {
            const ch = this.GetDigit(poolNumber, 12, d);
            if (ch !== ' ') eventStr += ch;
          }
          num1 = eventStr !== '' ? parseInt(eventStr, 10) : 0;
        } catch { num1 = 0; }

        // Read heat number by collecting non-space digits from positions 7-11.
        let num2 = 0;
        try {
          let heatStr = '';
          for (let d = 7; d <= 11; d++) {
            const ch = this.GetDigit(poolNumber, 12, d);
            if (ch !== ' ') heatStr += ch;
          }
          num2 = heatStr !== '' ? parseInt(heatStr, 10) : 0;
        } catch { num2 = 0; }

        // DIAGNOSTIC - remove once confirmed working
        console.log(`Module 12 parsed: event=${num1} heat=${num2} (keys in Events map: ${[...this.Gen7SwimmingData[poolNumber].Events.keys()].join(',')})`);

        if (this.CurrentEventNumber[poolNumber] !== num1) {
          // Capture the OLD event number before overwriting it - this is what
          // the case-2 backfill logic below needs "the previously displayed
          // event". (Previously this read CurrentEventNumber AFTER it had
          // already been reassigned to the new value on the line below, so
          // it always just mirrored the new event and the backfill for
          // session-2 events - which never get their own title packet -
          // silently never matched anything.)
          this._previousDisplayEventNumber = this.CurrentEventNumber[poolNumber];
          this.CurrentEventNumber[poolNumber] = num1;
          this.CurrentHeatNumber[poolNumber] = num2;
          // Reset the start list pointers so stale case 3 packets from the previous
          // event cannot be written into the wrong event entry in Gen7SwimmingData.
          // Any genuinely pending packets are also cleared - they belong to the old event.
          this._startListEventNumber = 0;
          this._startListHeatNumber = 0;
          this._pendingLaneData = [];
          this._commitStagedLanes();
          console.log(`Display event changed to ${num1}/${num2} - start list pointers reset (previous event was ${this._previousDisplayEventNumber})`);
          if (this.CurrentEventNumber[poolNumber] !== 0 && this.CurrentHeatNumber[poolNumber] !== 0 && this.CurrentSport[poolNumber] === Sport.Swimming) {
            this.emit('EventChange', { poolNumber, eventNumber: num1, heatNumber: num2 });
          }
        } else if (this.CurrentHeatNumber[poolNumber] !== num2) {
          // Same fix: capture the previous event number before it's overwritten.
          this._previousDisplayEventNumber = this.CurrentEventNumber[poolNumber];
          this.CurrentEventNumber[poolNumber] = num1;
          this.CurrentHeatNumber[poolNumber] = num2;
          // Same reset on heat change
          this._startListEventNumber = 0;
          this._startListHeatNumber = 0;
          this._pendingLaneData = [];
          this._commitStagedLanes();
          console.log(`Display heat changed to ${num1}/${num2} - start list pointers reset (previous event was ${this._previousDisplayEventNumber})`);
          if (this.CurrentEventNumber[poolNumber] !== 0 && this.CurrentHeatNumber[poolNumber] !== 0 && this.CurrentSport[poolNumber] === Sport.Swimming) {
            this.emit('HeatChange', { poolNumber, eventNumber: num1, heatNumber: num2 });
          }
        }
      } else if (this.currentModule === 31) {
        this.ParseNonModuleCommand(this._moduleCommandData);
      }
      this.currentModule = inc & 31;
      if (this.currentModule === 31) {
        this._inModuleCommand = true;
        this._moduleCommandData.length = 0;
      } else {
        if (this.currentModule < this.scbd[poolNumber].BoardData.length) {
          this.scbd[poolNumber].BoardData[this.currentModule].Univ = ((inc & 0x40) === 0x40);
          this.scbd[poolNumber].BoardData[this.currentModule].Horn = ((inc & 0x20) === 0x20);
        }
        this.dataByte1 = true;
        this.inCommand = false;
        this._inModuleCommand = false;
      }
    } else if (this._inModuleCommand) {
      this._moduleCommandData.push(inc);
    } else {
      if (this.inCommand) return;
      if (this.dataByte1) {
        this.currentDigit = inc & 31;
        if (this.currentModule < this.scbd[poolNumber].BoardData.length &&
            this.currentDigit < this.scbd[poolNumber].BoardData[this.currentModule].ModuleData.length) {
          this.scbd[poolNumber].BoardData[this.currentModule].ModuleData[this.currentDigit].DecPoint = ((inc & 0x40) === 0x40);
          this.scbd[poolNumber].BoardData[this.currentModule].ModuleData[this.currentDigit].SegmentMapped = ((inc & 0x20) === 0x20);
        }
        this.dataByte1 = false;
        if (this.currentDigit === 31) this.inCommand = true;
      } else {
        if (this.currentModule < this.scbd[poolNumber].BoardData.length &&
            this.currentDigit < this.scbd[poolNumber].BoardData[this.currentModule].ModuleData.length) {
          if (inc === 0) inc = 32;
          this.scbd[poolNumber].BoardData[this.currentModule].ModuleData[this.currentDigit].Value = inc & 0x7F;
        }
        this.dataByte1 = true;
      }
    }
  }

  ParseNonModuleCommand(cmd) {
    try {
      if (!cmd || cmd.length <= 1) return;
      // Raw packet passthrough for the diagnostics page / logging - emitted
      // before any parsing below so it reflects exactly what arrived.
      this.emit('packet', cmd);
      // DIAGNOSTIC - log every command arriving
      console.log(`ParseNonModuleCommand: cmd[0]=${cmd[0]} cmd[1]=${cmd[1]} cmd[2]=${cmd[2]} len=${cmd.length}`);
      // DIAGNOSTIC - full hex dump for cmd[0]=18 cmd[2]=2 (event title packets)
      if (cmd[0] === 18 && cmd[2] === 2) {
        const hex = Array.from(cmd).map(b => b.toString(16).padStart(2,'0')).join(' ');
        console.log(`ParseNonModuleCommand: EVENT TITLE raw hex: ${hex}`);
      }
      const num1 = cmd[1];

      // num1 is the 1-based session/pool number from the protocol.
      // Convert to 0-based index and ensure the slot exists before touching it.
      const poolIdx = num1 - 1;
      if (poolIdx < 0) return;
      this._ensurePool(poolIdx);

      switch (cmd[0]) {
        case 8:
          if (cmd.length < 4 || cmd[2] !== 0x7F) break;
          break;
        case 18:
          if (cmd.length <= 2) break;
          switch (cmd[2]) {
            case 1: {
              // Meet title
              const length1 = cmd[3];
              const text = this._subStringUTF8(cmd, 4, length1);
              console.log(`ParseNonModuleCommand: MeetTitle for pool ${poolIdx}: "${text}"`);
              this.Gen7SwimmingData[poolIdx].MeetTitle = text;
              this.Gen7SwimmingData[poolIdx].HasGen7Data = true;
              return;
            }
            case 2: {
              // Event title + heat header.
              // The timer sends this as a LOOKAHEAD for the next session 1 event
              // while the current event is still displaying. Session 2 events never
              // get their own cmd2=2 packet. So we store the title against the packet
              // event number as normal, but ALSO apply it to the previously displayed
              // event if that event has no title yet.
              //
              // IMPORTANT: The 16-bit event and heat numbers in this packet are encoded
              // using the same 0x7F escape scheme as text - bytes >= 0x80 are sent as
              // 0x7F followed by (byte & 0x7F). We must decode them properly otherwise
              // event numbers >= 128 (e.g. 202 = 0xCA) are misread.
              const _decodeEscapedByte = (arr, idx) => {
                if (arr[idx] === 0x7F) return ((arr[idx + 1] | 0x80) & 0xFF);
                return arr[idx] & 0xFF;
              };
              const _decodeEscaped16 = (arr, idx) => {
                // Each of the two bytes may independently be escaped
                let pos = idx;
                const hi = arr[pos] === 0x7F ? (pos++, pos++, (arr[pos - 1] | 0x80) & 0xFF) : arr[pos++] & 0xFF;
                const lo = arr[pos] === 0x7F ? (arr[pos + 1] | 0x80) & 0xFF : arr[pos] & 0xFF;
                return (hi << 8) | lo;
              };
              this._startListEventNumber = _decodeEscaped16(cmd, 3);
              this._startListHeatNumber = _decodeEscaped16(cmd, 5);
              // Title length and text start after the 4 encoded bytes (may be 4 or 6 bytes if escaped)
              // Use cmd[7] as length but find the actual text start by scanning past the encoded numbers
              let _titlePos = 3;
              // skip event number (1 or 2 bytes)
              if (cmd[_titlePos] === 0x7F) _titlePos += 2; else _titlePos += 1;
              if (cmd[_titlePos] === 0x7F) _titlePos += 2; else _titlePos += 1;
              // skip heat number (1 or 2 bytes)
              if (cmd[_titlePos] === 0x7F) _titlePos += 2; else _titlePos += 1;
              if (cmd[_titlePos] === 0x7F) _titlePos += 2; else _titlePos += 1;
              const _titleLen = cmd[_titlePos++];

              const eventTitle = this._subStringUTF8(cmd, _titlePos, _titleLen);
              console.log(`ParseNonModuleCommand: EventTitle for pool ${poolIdx}, event ${this._startListEventNumber}, heat ${this._startListHeatNumber}: "${eventTitle}"`);

              // This packet is a genuine "what's coming up next" lookahead
              // from the console (see note below on why it can't safely be
              // attributed to any specific currently-displayed event) - but
              // taken at face value, as "the next race", it's exactly right
              // for a get-ready prompt. Emit it as-is, unattributed.
              this.emit('nextRace', {
                poolNumber: poolIdx,
                eventNumber: this._startListEventNumber,
                heatNumber: this._startListHeatNumber,
                title: eventTitle
              });

              // Store against the packet's own event number as normal
              let swimmingEvent = this.Gen7SwimmingData[poolIdx].Events.get(this._startListEventNumber);
              if (!swimmingEvent) {
                swimmingEvent = new SwimmingEvent();
                this.Gen7SwimmingData[poolIdx].Events.set(this._startListEventNumber, swimmingEvent);
              }
              let heat = swimmingEvent.Heats.get(this._startListHeatNumber);
              if (!heat) {
                heat = new Heat();
                swimmingEvent.Heats.set(this._startListHeatNumber, heat);
              }
              swimmingEvent.EventTitle = eventTitle;

              // NOTE: session-2 events never get their own cmd2=2 title packet
              // from the console at all - this cmd2=2 is always a "lookahead"
              // for an upcoming session-1 event. An earlier version of this
              // code guessed that title also belonged to whatever event was
              // PREVIOUSLY on display (to fill in session-2 events), but that
              // guess is only correct if the console's session-1/session-2
              // events happen to be paired in that exact order - confirmed
              // wrong on real data (a session-2 heat showed an unrelated
              // session-1 event's title). Showing no title is better than
              // showing a wrong one on a live broadcast, so we no longer
              // guess: an event only gets a title from its own genuine
              // cmd2=2 packet, and session-2 events simply have none.

              // Replay any case 3 packets that arrived before this case 2
              if (this._pendingLaneData.length > 0) {
                console.log(`ParseNonModuleCommand: replaying ${this._pendingLaneData.length} queued lane packets for event ${this._startListEventNumber} heat ${this._startListHeatNumber}`);
                for (const pending of this._pendingLaneData) {
                  const lane = heat[pending.index];
                  if (lane) {
                    lane.LastName = pending.lastName;
                    lane.Team = pending.team;
                    console.log(`ParseNonModuleCommand: replayed lane ${pending.index}: "${lane.LastName}" (${lane.Team})`);
                  }
                }
                heat.HasGen7Data = Array.from(heat).some(l => l.LastName && l.LastName.trim().length > 0);
                this._pendingLaneData = [];
              }
              return;
            }
            case 3: {
              // Swimmer name/team.
              // The timer does not always send a case 2 (event title) packet before case 3
              // swimmer packets - particularly for session 2+ events. In that case
              // _startListEventNumber will be 0. We fall back to using the current display
              // event/heat number from CurrentEventNumber/CurrentHeatNumber to create the
              // event/heat entry on the fly so swimmers are stored in the right place.
              const index = cmd[3];
              const length3 = cmd[4];
              const length4 = cmd[5];
              const lastName = this._subStringUTF8(cmd, 7, length3);
              const team = this._subStringUTF8(cmd, 7 + length3, length4);

              // If _startListEventNumber is 0 there was no case 2 for this burst
              // (always the case for session-2 events).
              let targetEvent = this._startListEventNumber;
              let targetHeat = this._startListHeatNumber;
              if (targetEvent === 0 && this.CurrentEventNumber[poolIdx] > 0) {
                // The console sends the swimmer packets for the heat it is
                // ABOUT to show a few ms BEFORE it flips module 12 to that
                // heat (confirmed in real meet logs: new heat's names landed
                // in the old heat's slot, so the outgoing result screen
                // already showed the new names). So we can't tell yet which
                // heat these belong to - stage them. They are committed to
                // the NEW heat if module 12 changes within STAGE_QUIET_MS,
                // otherwise (an idle re-broadcast of the current heat) to
                // the current heat once the burst goes quiet.
                this._stageFallbackLane(poolIdx, index, lastName, team);
                return;
              }

              if (targetEvent === 0) {
                console.log(`ParseNonModuleCommand: queuing lane ${index} pool ${poolIdx} - no event known yet`);
                this._pendingLaneData.push({ index, lastName, team });
                return;
              }

              this._storeLane(poolIdx, targetEvent, targetHeat, index, lastName, team);
              return;
            }
            case 4: {
              // Event data complete marker
              try {
                const evt = this.Gen7SwimmingData[poolIdx].Events.get(this._startListEventNumber);
                evt.HasGen7Data = Array.from(evt.Heats.values()).some(h => h.HasGen7Data);
                return;
              } catch {
                return;
              }
            }
            default:
              return;
          }
      }
    } catch (ex) {
      console.log('ParseNonModuleCommand error:', ex.message);
    }
  }

  // Write one swimmer (lane index 0-based) into Gen7SwimmingData, creating
  // the event/heat entries on the fly if needed.
  _storeLane(poolIdx, targetEvent, targetHeat, index, lastName, team) {
    let swimmingEvent = this.Gen7SwimmingData[poolIdx].Events.get(targetEvent);
    if (!swimmingEvent) {
      console.log(`ParseNonModuleCommand: creating event ${targetEvent} on the fly for pool ${poolIdx}`);
      swimmingEvent = new SwimmingEvent();
      this.Gen7SwimmingData[poolIdx].Events.set(targetEvent, swimmingEvent);
    }
    let heatData = swimmingEvent.Heats.get(targetHeat);
    if (!heatData) {
      console.log(`ParseNonModuleCommand: creating heat ${targetHeat} on the fly for event ${targetEvent}`);
      heatData = new Heat();
      swimmingEvent.Heats.set(targetHeat, heatData);
    }

    const lane = heatData[index];
    if (!lane) {
      console.log(`ParseNonModuleCommand: lane index ${index} out of range for event ${targetEvent} heat ${targetHeat}`);
      return;
    }

    lane.LastName = lastName;
    lane.Team = team;
    console.log(`ParseNonModuleCommand: Lane ${index} pool ${poolIdx} event ${targetEvent}/${targetHeat}: "${lane.LastName}" (${lane.Team})`);

    heatData.HasGen7Data = Array.from(heatData).some(l => l.LastName && l.LastName.trim().length > 0);
    swimmingEvent.HasGen7Data = Array.from(swimmingEvent.Heats.values()).some(h => h.HasGen7Data);
  }

  _stageFallbackLane(poolIdx, index, lastName, team) {
    if (!this._stagedLanes || this._stagedPool !== poolIdx) {
      this._stagedLanes = new Map();
      this._stagedPool = poolIdx;
    }
    this._stagedLanes.set(index, { lastName, team });
    console.log(`ParseNonModuleCommand: staged lane ${index} pool ${poolIdx} "${lastName}" (${team}) - heat not yet known`);
    if (this._stageTimer) clearTimeout(this._stageTimer);
    this._stageTimer = setTimeout(() => this._commitStagedLanes(), STAGE_QUIET_MS);
    if (this._stageTimer.unref) this._stageTimer.unref();
  }

  // Commit any staged swimmer packets to whatever heat is displayed RIGHT
  // NOW. Called when the burst goes quiet, and (after Current* is updated)
  // when module 12 changes heat, so a pre-change burst lands in the new heat.
  _commitStagedLanes() {
    if (this._stageTimer) { clearTimeout(this._stageTimer); this._stageTimer = null; }
    if (!this._stagedLanes || this._stagedLanes.size === 0) return;
    const poolIdx = this._stagedPool;
    const ev = this.CurrentEventNumber[poolIdx];
    const heat = this.CurrentHeatNumber[poolIdx];
    const staged = this._stagedLanes;
    this._stagedLanes = null;
    if (!(ev > 0)) return;
    for (const [index, v] of staged) {
      this._storeLane(poolIdx, ev, heat, index, v.lastName, v.team);
    }
  }

  _subStringUTF8(arr, startIndex, length) {
    if (startIndex < 0 || length < 0 || startIndex > arr.length - 1 || startIndex + length > arr.length) return '';
    const bytes = [];
    let i = startIndex;
    const end = startIndex + length;
    while (i < end) {
      let ch = arr[i++];
      if (ch === 0x7F) {
        const next = arr[i++] || 0;
        ch = (next | 0x80) & 0xFF;
      }
      bytes.push(ch);
    }
    return Buffer.from(bytes).toString('utf8').trim();
  }

  DetectCurrentSport(poolNumber) {
    this._ensurePool(poolNumber);
    this.CurrentSport[poolNumber] = Sport.Swimming;
  }

  DataToChar(data, spec) {
    if (data === 0 || data === 15) return ' ';
    return String.fromCharCode(data);
  }

  GetDigit(poolNumber, module, digit) {
    this._ensurePool(poolNumber);
    if (poolNumber < this.scbd.length && module < this.scbd[poolNumber].BoardData.length) {
      const moduleData = this.scbd[poolNumber].BoardData[module].ModuleData;
      if (digit < moduleData.length) return this.DataToChar(moduleData[digit].Value, false);
    }
    return ' ';
  }

  GetTime(poolNumber, module, startdigit, count, fillWithUniversal = true) {
    this._ensurePool(poolNumber);
    if (module > 30) return '';
    let sb = '';
    const module1 = (!fillWithUniversal || !this.scbd[poolNumber].BoardData[module].Univ) ? module : 0;
    for (let digit = startdigit; digit < startdigit + count; ++digit) {
      if (digit === startdigit + 2) {
        if (module === 0 || (this.DecPointLit(poolNumber, module, digit) && this.GetDigit(poolNumber, module1, digit - 1) !== ' '))
          sb += ':';
        sb += this.GetDigit(poolNumber, module1, digit);
      } else if (digit === startdigit + 3 && (this.DecPointLit(poolNumber, module, digit) || module === 0)) {
        sb += this.GetDigit(poolNumber, module1, digit);
        sb += '.';
      } else if (digit === startdigit + 1 && this.DecPointLit(poolNumber, module, digit)) {
        sb += this.GetDigit(poolNumber, module1, digit);
        sb += '.';
      } else {
        sb += this.GetDigit(poolNumber, module1, digit);
      }
    }
    return sb.trim();
  }

  GetDigits(poolNumber, module, startDigit, numDigits, decPointPos, colonPos) {
    this._ensurePool(poolNumber);
    if (module > 30 || startDigit + numDigits > 30) return '';
    const module1 = (!this.scbd[poolNumber].BoardData[module].Univ || startDigit <= 3 || startDigit >= 10) ? module : 0;
    if ((startDigit === 0 || startDigit === 2) && numDigits === 1) {
      return `${this.GetDigit(poolNumber, module1, startDigit)}${this.GetDigit(poolNumber, module1, startDigit + 1)}`.trim();
    }
    let sb = '';
    let digit = startDigit;
    for (let index = startDigit; index < startDigit + numDigits; ++index) {
      if (colonPos >= 0 && index === colonPos && this.DecPointLit(poolNumber, module, digit)) sb += ':';
      if (module1 < 25 || module1 > 30 || startDigit !== 0 || (index !== 0 && index !== 2)) {
        sb += this.GetDigit(poolNumber, module1, digit);
        if (decPointPos >= 0 && index === decPointPos && this.DecPointLit(poolNumber, module, digit)) sb += '.';
        if (digit === 1 && startDigit === 1) ++digit;
        ++digit;
      }
    }
    const out = sb.trim();
    return out === '.' ? '' : out;
  }

  async printDemo(loopMs = 100) {
    while (true) {
      console.clear();
      console.log(`Event ${this.CurrentEventNumber[0]} - Heat ${this.CurrentHeatNumber[0]}`);
      console.log(`Meet Title: ${this.Gen7SwimmingData[0] ? this.Gen7SwimmingData[0].MeetTitle : ''}`);
      console.log(`Pool slots active: ${this.Gen7SwimmingData.length}`);

      let swmevt = null;
      const meet = (this.Gen7SwimmingData && this.Gen7SwimmingData.length > 0) ? this.Gen7SwimmingData[0] : null;
      if (meet && meet.HasGen7Data && this.CurrentEventNumber && this.CurrentEventNumber.length > 0) {
        const evt = this.CurrentEventNumber[0];
        if (evt > 0 && meet.Events && meet.Events.has(evt)) swmevt = meet.Events.get(evt);
      }
      let swmheat = null;
      if (swmevt && this.CurrentHeatNumber && this.CurrentHeatNumber.length > 0) {
        const heat = this.CurrentHeatNumber[0];
        if (heat > 0 && swmevt.Heats && swmevt.Heats.has(heat)) swmheat = swmevt.Heats.get(heat);
      }
      const EventTitle = swmevt ? swmevt.EventTitle : '';
      console.log(`Event Title: ${EventTitle}`);

      for (let indexmodule = 0; indexmodule <= 10; ++indexmodule) {
        let out = '';
        for (let indexdata = 0; indexdata <= this.scbd[0].BoardData[indexmodule].ModuleData.length - 1; ++indexdata) {
          out += Gen7Scbd.DataToChar(this.scbd[0].BoardData[indexmodule].ModuleData[indexdata].Value, false);
        }
        const lane = swmheat && indexmodule < swmheat.length ? swmheat[indexmodule] : null;
        const swimmerName = lane && (((lane.LastName || '').length + (lane.FirstName || '').length) > 0)
          ? `${lane.FirstName} ${lane.LastName} (${lane.Team})`
          : '';
        console.log(`GetTime Module:${indexmodule}: ${this.GetTime(0, indexmodule, 4, 30, true)}   SwimmerName: ${swimmerName}`);
      }

      await new Promise(r => setTimeout(r, loopMs));
    }
  }
}

module.exports = { Gen7Scbd, Lane, Heat, SwimmingEvent, Meet, EnhancedScoreboard, ScoreboardState, Sport };