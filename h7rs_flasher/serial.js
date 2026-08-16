const CMD_HELLO    = 0x01;
const CMD_BEGIN    = 0x02;
const CMD_DATA     = 0x03;
const CMD_FINISH   = 0x04;
const CMD_STATUS   = 0x05;
const CMD_ABORT    = 0x06;

const REPLY_READY        = 0x11;
const REPLY_WAIT_CONFIRM = 0x12;
const REPLY_ACCEPT_DATA  = 0x14;
const REPLY_ACK          = 0x15;
const REPLY_BUSY         = 0x17;
const REPLY_SUCCESS      = 0x19;
const REPLY_ERROR        = 0x1A;

const ERR_NAMES = {
    0x20: "坏帧 (BAD_FRAME)",
    0x21: "版本错误 (BAD_VERSION)",
    0x22: "CRC校验失败 (BAD_CRC)",
    0x23: "大小错误 (BAD_SIZE)",
    0x24: "包错误 (BAD_PACKAGE)",
    0x25: "序列号错误 (BAD_SEQUENCE)",
    0x26: "偏移量错误 (BAD_OFFSET)",
    0x27: "Flash写入/擦除失败 (FLASH_ERROR)",
    0x28: "校验失败 (VERIFY_ERROR)",
    0x29: "通讯超时 (TIMEOUT)",
    0x2A: "用户取消 (CANCELLED)",
    0x2B: "LCD尺寸与当前固件不匹配"
};

class SerialFlasher {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.rxBuffer = new Uint8Array(0);
        this.sequence = 0;
        this.currentGeneration = 0;
        this.replyQueue = [];
        
        this.onLog = (msg) => console.log(msg);
        this.onProgress = (percent, msg) => {};
        this.onError = (msg) => {};
        
        this.replyWaiter = null;
        this.isConnected = false;
    }

    async connect() {
        try {
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }]
            });
            await this.port.open({ baudRate: 115200 }); 
            this.writer = this.port.writable.getWriter();
            this.rxBuffer = new Uint8Array(0);
            this.replyQueue = [];
            this.replyWaiter = null;
            this.isConnected = true;
            this.readLoopPromise = this._readLoop();
            this.onLog("已连接到板卡");
            return true;
        } catch (e) {
            this.onError("连接失败: " + e.message);
            return false;
        }
    }

    async disconnect() {
        this.isConnected = false;
        if (this.replyWaiter) {
            this.replyWaiter.reject(new Error("设备已断开"));
            this.replyWaiter = null;
        }
        this.replyQueue = [];
        if (this.reader) await this.reader.cancel().catch(()=>{});
        if (this.writer) this.writer.releaseLock();
        if (this.port) await this.port.close().catch(()=>{});
    }

    async _readLoop() {
        this.reader = this.port.readable.getReader();
        try {
            while (this.isConnected) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    const newBuf = new Uint8Array(this.rxBuffer.length + value.length);
                    newBuf.set(this.rxBuffer);
                    newBuf.set(value, this.rxBuffer.length);
                    this.rxBuffer = newBuf;
                    this._processRx();
                }
            }
        } catch (error) {
            this.onError("串口读取错误: " + error.message);
            this.disconnect();
        } finally {
            if (this.reader) this.reader.releaseLock();
        }
    }

    _processRx() {
        while (this.rxBuffer.length >= 12) { 
            const view = new DataView(this.rxBuffer.buffer, this.rxBuffer.byteOffset, this.rxBuffer.byteLength);
            const magic = view.getUint32(0, true);
            
            if (magic !== 0x50553748) {
                this.rxBuffer = this.rxBuffer.slice(1);
                continue;
            }

            const payloadLength = view.getUint16(6, true);
            const totalLength = 12 + payloadLength + 4; // header(12) + payload + crc(4)
            if (this.rxBuffer.length < totalLength) break; 

            const frameBuf = this.rxBuffer.slice(0, totalLength);
            this.rxBuffer = this.rxBuffer.slice(totalLength);

            const receivedCrc = new DataView(frameBuf.buffer, frameBuf.byteOffset).getUint32(12 + payloadLength, true);
            const calcCrc = PackageBuilder.crc32(frameBuf, 4, 8 + payloadLength);
            
            if (receivedCrc === calcCrc) {
                const command = view.getUint8(5);
                const sequence = view.getUint32(8, true);
                const payload = frameBuf.slice(12, 12 + payloadLength);
                
                this._deliverReply({ code: command, payload, sequence });
            } else {
                this.onLog("CRC校验失败，丢弃回复包");
            }
        }
    }

    _deliverReply(reply) {
        if (this.replyWaiter && this.replyWaiter.sequence === reply.sequence) {
            const waiter = this.replyWaiter;
            this.replyWaiter = null;
            waiter.resolve(reply);
            return;
        }

        /* 回复可能紧跟在USB写入后到达，先缓存可避免等待器尚未建立时丢包。 */
        this.replyQueue.push(reply);
        if (this.replyQueue.length > 16) {
            this.replyQueue.shift();
        }
    }

    _parseReply(reply, expectedCode) {
        if (reply.code === REPLY_ERROR && reply.payload.length > 0) {
            const errCode = reply.payload[0];
            const errMsg = ERR_NAMES[errCode] || `未知错误 (0x${errCode.toString(16)})`;
            throw new Error(errMsg);
        }
        if (reply.code === REPLY_BUSY) {
            throw new Error("设备忙碌 (BUSY)");
        }
        if (reply.code !== expectedCode) {
            throw new Error(`收到意外回复 0x${reply.code.toString(16)}`);
        }
        return reply.payload;
    }

    async _waitForReply(expectedCode, expectedSeq, timeoutMs) {
        const queuedIndex = this.replyQueue.findIndex(reply => reply.sequence === expectedSeq);
        if (queuedIndex >= 0) {
            const reply = this.replyQueue.splice(queuedIndex, 1)[0];
            return this._parseReply(reply, expectedCode);
        }

        if (this.replyWaiter) {
            throw new Error("内部错误：已有回复等待任务");
        }

        const reply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.replyWaiter = null;
                reject(new Error("通讯超时"));
            }, timeoutMs);

            this.replyWaiter = {
                sequence: expectedSeq,
                resolve: value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                }
            };
        });

        return this._parseReply(reply, expectedCode);
    }

    async _sendFrame(command, payload, expectedReply, timeoutMs, retries, expectedSeq = null) {
        if (!this.isConnected) throw new Error("未连接设备");

        const seq = this.sequence;
        if (expectedSeq === null) expectedSeq = seq;
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            const payloadLen = payload ? payload.length : 0;
            const buf = new Uint8Array(12 + payloadLen + 4); // 12(header) + payload + 4(crc)
            const view = new DataView(buf.buffer);
            
            view.setUint32(0, 0x50553748, true); // magic
            view.setUint8(4, 1); // version
            view.setUint8(5, command); // command
            view.setUint16(6, payloadLen, true); // payload length
            view.setUint32(8, seq, true); // sequence

            if (payloadLen > 0) buf.set(payload, 12);

            const crc = PackageBuilder.crc32(buf, 4, 8 + payloadLen);
            view.setUint32(12 + payloadLen, crc, true);

            // 必须在写之前挂载好监听，避免竞争条件漏收
            const p = this._waitForReply(expectedReply, expectedSeq, timeoutMs);
            try {
                await this.writer.write(buf);
                const res = await p;
                if (command !== CMD_STATUS) {
                    this.sequence++;
                }
                return res;
            } catch (err) {
                if (this.replyWaiter && this.replyWaiter.sequence === expectedSeq) {
                    this.replyWaiter.reject(err);
                    this.replyWaiter = null;
                    await p.catch(() => {});
                }
                if (attempt === retries) {
                    throw err;
                }
                this.onLog(`重传中... (${attempt}/${retries}) - ${err.message}`);
            }
        }
    }

    async flash(packageData, lcdWidth, lcdHeight) {
        try {
            if (!Number.isInteger(lcdWidth) || !Number.isInteger(lcdHeight) ||
                lcdWidth < 1 || lcdWidth > 65535 || lcdHeight < 1 || lcdHeight > 65535) {
                throw new Error("LCD尺寸无效");
            }

            /* 每次烧录都由HELLO建立新会话，下位机此时固定从Sequence 0开始。 */
            this.sequence = 0;
            this.replyQueue = [];
            this.replyWaiter = null;

            this.onProgress(0, "发送握手 (HELLO)...");
            const readyPayload = await this._sendFrame(CMD_HELLO, null, REPLY_READY, 1000, 3);
            if (readyPayload && readyPayload.length >= 4) {
                this.currentGeneration = new DataView(readyPayload.buffer, readyPayload.byteOffset).getUint32(0, true);
                this.onLog("下位机当前代数: " + this.currentGeneration);
            }

            // 更新包中的代数 (currentGeneration + 1)
            const nextGen = this.currentGeneration + 1;
            new DataView(packageData.buffer, packageData.byteOffset).setUint32(12, nextGen, true);
            // 重新计算目录CRC
            const dirView = new DataView(packageData.buffer, packageData.byteOffset);
            const magicBackup = dirView.getUint32(0, true);
            dirView.setUint32(0, 0, true);
            dirView.setUint32(32, 0, true);
            const dirCrc = PackageBuilder.crc32(packageData, 0, 0x1000);
            dirView.setUint32(0, magicBackup, true);
            dirView.setUint32(32, dirCrc, true);

            this.onProgress(5, "发送起始信息 (BEGIN)...");
            const beginPayload = new Uint8Array(8);
            const beginView = new DataView(beginPayload.buffer);
            beginView.setUint32(0, packageData.length, true);
            beginView.setUint16(4, lcdWidth, true);
            beginView.setUint16(6, lcdHeight, true);
            const beginSeq = this.sequence;
            await this._sendFrame(CMD_BEGIN, beginPayload, REPLY_WAIT_CONFIRM, 1000, 3);

            this.onProgress(10, "请在板卡上确认并等待擦除...");
            await this._waitForReply(REPLY_ACCEPT_DATA, beginSeq, 35000);

            this.onProgress(15, "开始发送数据...");
            const chunkSize = 1020; 
            let offset = 0;
            const total = packageData.length;
            const transferStartTime = performance.now();

            while (offset < total) {
                let len = Math.min(chunkSize, total - offset);
                // 必须在 0x1000 处截断，不可跨越固件的 header / payload 边界
                if (offset < 0x1000 && offset + len > 0x1000) {
                    len = 0x1000 - offset;
                }
                
                const chunk = packageData.slice(offset, offset + len);
                
                const dataPayload = new Uint8Array(4 + len);
                new DataView(dataPayload.buffer).setUint32(0, offset, true);
                dataPayload.set(chunk, 4);

                await this._sendFrame(CMD_DATA, dataPayload, REPLY_ACK, 1000, 5);
                
                offset += len;
                const percent = 15 + Math.floor((offset / total) * 80);
                const elapsedSeconds = Math.max(0.001, (performance.now() - transferStartTime) / 1000);
                const speedKbps = offset / 1024 / elapsedSeconds;
                this.onProgress(percent, `传输中: ${offset} / ${total} 字节，${speedKbps.toFixed(1)} KB/s`);
            }

            this.onProgress(95, "传输完成，请求校验 (FINISH)...");
            await this._sendFrame(CMD_FINISH, null, REPLY_SUCCESS, 10000, 3);

            this.onProgress(100, "烧录成功！");
            
        } catch (err) {
            let errorDetails = err.message;
            // 尝试获取板卡状态和期望偏移量以及Sequence
            try {
                // 特殊发送 STATUS，不推进本地 Sequence（即使成功也不在此处无脑推进）
                const statusPayload = await this._sendFrame(CMD_STATUS, null, REPLY_ACK, 1000, 1);
                if (statusPayload && statusPayload.length >= 10) {
                    const dv = new DataView(statusPayload.buffer, statusPayload.byteOffset);
                    const lastError = dv.getUint8(1);
                    const expectedSequence = dv.getUint32(2, true);
                    const expOffset = dv.getUint32(6, true);
                    
                    // 必须根据板卡返回的实际情况重新同步 sequence，防止后续 ABORT 错乱
                    this.sequence = expectedSequence;
                    
                    if (lastError !== 0) {
                        errorDetails += ` (错误码: 0x${lastError.toString(16)}, 期望Offset: ${expOffset})`;
                    }
                }
            } catch(e) {}
            
            this.onError("错误: " + errorDetails);
            try { await this._sendFrame(CMD_ABORT, null, REPLY_ACK, 1000, 1); } catch(e){}
            throw new Error(errorDetails);
        }
    }
}
