import { Storage } from '../services/storage';
import { ObjectID, Collection, MongoClient, Db } from 'mongodb';
import { Writable, Readable } from 'stream';
import { partition } from '../utils/partition';

export type MongoBound<T> = T & Partial<{ _id: ObjectID }>;
export abstract class BaseModel<T> {
  connected = false;
  client?: MongoClient;
  db?: Db;

  // each model must implement an array of keys that are indexed, for paging
  abstract allowedPaging: Array<{
    type: 'string' | 'number' | 'date';
    key: keyof T;
  }>;

  constructor(private collectionName: string, private storageService = Storage) {
    this.handleConnection();
  }

  private async handleConnection() {
    const doConnect = async () => {
      if (this.storageService.db != undefined) {
        this.connected = true;
        this.db = this.storageService.db;
        await this.onConnect();
      }
    };
    if (this.storageService.connected) {
      await doConnect();
    } else {
      this.storageService.connection.on('CONNECTED', async () => {
        await doConnect();
      });
    }
  }

  abstract async onConnect();

  get collection(): Collection<MongoBound<T>> {
    if (this.storageService.db) {
      return this.storageService.db.collection(this.collectionName);
    } else {
      throw new Error('Not connected to the database yet');
    }
  }

  async bulkImport(ops: Array<any>, partitionSize: number): Promise<any> {
    const collection = this.collection;
    let opIndex = 0;
    ops = partition(ops, partitionSize);
    const opInputStream = new Readable({
      objectMode: true,
      read() {
        if (opIndex < ops.length) {
          this.push(ops[opIndex]);
          opIndex++;
        }
        else {
          this.push(null);
        }
      }
    });

    const bulkWriter = new Writable({
      objectMode: true,
      async write(chunk, _, callback) {
        try {
          await collection.bulkWrite(chunk);
          callback();
        } catch (err) {
          callback(err);
        }
      }
    });

    return new Promise((resolve, reject) => {
      bulkWriter.on('unpipe', resolve);
      bulkWriter.on('error', (err) => {
        bulkWriter.destroy();
        reject(err);
      });
      opInputStream.pipe(bulkWriter);
    });
  }
}
