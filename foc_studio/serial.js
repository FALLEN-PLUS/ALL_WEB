"use strict";

class FocSerial
{
    constructor()
    {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.rxBuffer = new Uint8Array(0);
        this.txChain = Promise.resolve();
        this.isConnected = false;
        this.frameCount = 0;
        this.resyncByteCount = 0;
        this.invalidFrameCount = 0;
        this.connectionGeneration = 0;

        this.onFrame = () => {};
        this.onTransmit = () => {};
        this.onConnectionChange = () => {};
        this.onError = () => {};
    }

    async connect()
    {
        if (!("serial" in navigator))
        {
            throw new Error("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge");
        }
        if (this.isConnected)
        {
            return;
        }

        this.port = await navigator.serial.requestPort();
        await this.port.open({
            baudRate: 460800,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            flowControl: "none",
            bufferSize: 65536
        });

        this.writer = this.port.writable.getWriter();
        this.connectionGeneration++;
        this.txChain = Promise.resolve();
        this.rxBuffer = new Uint8Array(0);
        this.frameCount = 0;
        this.resyncByteCount = 0;
        this.invalidFrameCount = 0;
        this.isConnected = true;
        this.onConnectionChange(true);
        this.readLoopPromise = this.readLoop();
    }

    async disconnect()
    {
        if (!this.port)
        {
            return;
        }

        this.isConnected = false;
        this.connectionGeneration++;
        // Why: writer.write()可能仍在执行，必须等旧发送链结束后才能释放writer锁。
        const pendingWrites = this.txChain;
        this.txChain = Promise.resolve();
        await pendingWrites.catch(() => {});
        if (this.reader)
        {
            await this.reader.cancel().catch(() => {});
        }
        if (this.readLoopPromise)
        {
            await this.readLoopPromise.catch(() => {});
            this.readLoopPromise = null;
        }
        if (this.writer)
        {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close().catch(() => {});
        this.port = null;
        this.rxBuffer = new Uint8Array(0);
        this.txChain = Promise.resolve();
        this.onConnectionChange(false);
    }

    async readLoop()
    {
        this.reader = this.port.readable.getReader();
        let unexpectedError = null;

        try
        {
            while (this.isConnected)
            {
                const { value, done } = await this.reader.read();
                if (done)
                {
                    break;
                }
                if (value && value.length > 0)
                {
                    this.appendReceiveData(value);
                }
            }
        }
        catch (error)
        {
            if (this.isConnected)
            {
                unexpectedError = error;
            }
        }
        finally
        {
            if (this.reader)
            {
                this.reader.releaseLock();
                this.reader = null;
            }
        }

        if (this.isConnected)
        {
            this.isConnected = false;
            this.connectionGeneration++;
            const pendingWrites = this.txChain;
            this.txChain = Promise.resolve();
            await pendingWrites.catch(() => {});
            if (unexpectedError)
            {
                this.onError("串口读取中断：" + unexpectedError.message);
            }
            else
            {
                this.onError("串口连接已结束，请检查 USB 连接");
            }
            if (this.writer)
            {
                this.writer.releaseLock();
                this.writer = null;
            }
            if (this.port)
            {
                await this.port.close().catch(() => {});
                this.port = null;
            }
            this.onConnectionChange(false);
        }
    }

    appendReceiveData(chunk)
    {
        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;
        this.processReceiveBuffer();

        if (this.rxBuffer.length > 4096)
        {
            const keep = this.rxBuffer.slice(-23);
            this.resyncByteCount += this.rxBuffer.length - keep.length;
            this.rxBuffer = keep;
        }
    }

    processReceiveBuffer()
    {
        const tail = [0x00, 0x00, 0x80, 0x7F];

        while (this.rxBuffer.length >= 4)
        {
            const tailIndex = this.findSequence(this.rxBuffer, tail);
            if (tailIndex < 0)
            {
                return;
            }

            if (tailIndex < 20)
            {
                this.resyncByteCount += tailIndex + 4;
                this.rxBuffer = this.rxBuffer.slice(tailIndex + 4);
                continue;
            }

            const frameStart = tailIndex - 20;
            if (frameStart > 0)
            {
                this.resyncByteCount += frameStart;
            }
            const payload = this.rxBuffer.slice(frameStart, tailIndex);
            this.rxBuffer = this.rxBuffer.slice(tailIndex + 4);

            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const values = [];
            let valid = true;
            for (let i = 0; i < 5; i++)
            {
                const value = view.getFloat32(i * 4, true);
                if (!Number.isFinite(value))
                {
                    valid = false;
                    break;
                }
                values.push(value);
            }

            if (valid)
            {
                this.frameCount++;
                this.onFrame(values);
            }
            else
            {
                this.invalidFrameCount++;
            }
        }
    }

    findSequence(data, sequence)
    {
        const lastStart = data.length - sequence.length;
        for (let i = 0; i <= lastStart; i++)
        {
            let matched = true;
            for (let j = 0; j < sequence.length; j++)
            {
                if (data[i + j] !== sequence[j])
                {
                    matched = false;
                    break;
                }
            }
            if (matched)
            {
                return i;
            }
        }
        return -1;
    }

    sendCommand(command, rawData = 0, aux = 0)
    {
        if (!this.isConnected || !this.writer)
        {
            return Promise.reject(new Error("串口尚未连接"));
        }

        const raw = rawData & 0xFFFF;
        const generation = this.connectionGeneration;
        const frame = new Uint8Array([
            0xFF,
            command & 0xFF,
            raw & 0xFF,
            (raw >>> 8) & 0xFF,
            aux & 0xFF,
            0xFE
        ]);

        const operation = async () =>
        {
            if (!this.isConnected || !this.writer || generation !== this.connectionGeneration)
            {
                throw new Error("串口连接已变更，旧命令已丢弃");
            }
            await this.writer.write(frame);
            this.onTransmit(frame);
        };

        const result = this.txChain.then(operation, operation);
        this.txChain = result.catch(() => {});
        return result;
    }

    static toHex(bytes)
    {
        return Array.from(bytes, value => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    }
}

window.FocSerial = FocSerial;
