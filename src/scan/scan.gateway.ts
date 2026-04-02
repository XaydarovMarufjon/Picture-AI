import {
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
    cors: { origin: '*' },
})
export class ScanGateway {
    @WebSocketServer()
    server: Server;

    sendProgress(data: any) {
        this.server.emit('scan-progress', data);
    }
}