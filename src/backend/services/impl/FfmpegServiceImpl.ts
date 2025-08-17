// @/backend/services/impl/FfmpegServiceImpl.ts
import {inject, injectable, postConstruct} from 'inversify';
import {WaitLock} from '@/common/utils/Lock';
import {spawn} from 'child_process';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import TYPES from '@/backend/ioc/types';
import FfmpegService from '@/backend/services/FfmpegService';
import DpTaskService from '@/backend/services/DpTaskService';
import LocationService, {ProgramType} from '@/backend/services/LocationService';
import FfmpegTask from '@/backend/objs/FfmpegTask';
import dpLog from '@/backend/ioc/logger';
import {VideoInfo} from '@/common/types/video-info';
import {CancelByUserError} from '@/backend/errors/errors';
import {FfmpegCommands} from '@/backend/utils/FfmpegCommands';

@injectable()
export default class FfmpegServiceImpl implements FfmpegService {
    @inject(TYPES.DpTaskService)
    private dpTaskService!: DpTaskService;
    @inject(TYPES.LocationService)
    private locationService!: LocationService;

    /**
     * 分割视频
     */
    @WaitLock('ffmpeg')
    public async splitVideo({
                                inputFile,
                                startSecond,
                                endSecond,
                                outputFile
                            }: {
        inputFile: string,
        startSecond: number,
        endSecond: number,
        outputFile: string
    }): Promise<void> {
        const args = FfmpegCommands.buildSplitVideoArgs(inputFile, startSecond, endSecond, outputFile);
        await this.executeRawCommand(args);
    }

    /**
     * 按时间点分割视频
     */
    @WaitLock('ffmpeg')
    public async splitVideoByTimes({
                                       inputFile,
                                       times,
                                       outputFolder,
                                       outputFilePrefix
                                   }: {
        inputFile: string,
        times: number[],
        outputFolder: string,
        outputFilePrefix: string
    }): Promise<string[]> {
        const outputFormat = path.join(outputFolder, `${outputFilePrefix}_%03d${path.extname(inputFile)}`);
        const command = FfmpegCommands.buildSplitVideoByTimes(inputFile, times, outputFormat);

        await this.executeFluentCommand(command);
        return await this.getOutputFiles(outputFolder, outputFilePrefix);
    }

    /**
     * 获取视频时长
     */
    @WaitLock('ffprobe')
    public async duration(filePath: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata.format.duration ?? 0);
            });
        });
    }

    /**
     * 获取视频信息
     */
    @WaitLock('ffprobe')
    public async getVideoInfo(filePath: string): Promise<VideoInfo> {
        const stats = await fs.promises.stat(filePath);
        const probeData = await new Promise<any>((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
            });
        });

        return {
            filename: path.basename(filePath),
            duration: probeData.format.duration || 0,
            size: stats.size,
            modifiedTime: stats.mtimeMs,
            createdTime: stats.ctimeMs,
            bitrate: probeData.format.bit_rate ? parseInt(probeData.format.bit_rate) : undefined,
            videoCodec: probeData.streams.find((s: any) => s.codec_type === 'video')?.codec_name,
            audioCodec: probeData.streams.find((s: any) => s.codec_type === 'audio')?.codec_name
        };
    }

    /**
     * 生成缩略图
     */
    @WaitLock('ffmpeg')
    public async thumbnail({
                               inputFile,
                               outputFileName,
                               outputFolder,
                               time
                           }: {
        inputFile: string,
        outputFileName: string,
        outputFolder: string,
        time: number
    }): Promise<void> {
        const totalDuration = await this.duration(inputFile);
        const actualTime = Math.min(time, totalDuration);

        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder, {recursive: true});
        }

        const command = FfmpegCommands.buildThumbnail(inputFile, outputFolder, outputFileName, actualTime);
        await this.executeFluentCommand(command);
    }

    /**
     * 分割为音频文件
     */
    @WaitLock('ffmpeg')
    public async splitToAudio({
                                  taskId,
                                  inputFile,
                                  outputFolder,
                                  segmentTime,
                                  onProgress
                              }: {
        taskId: number,
        inputFile: string,
        outputFolder: string,
        segmentTime: number,
        onProgress?: (percent: number) => void
    }): Promise<string[]> {
        const outputFormat = path.join(outputFolder, 'output_%03d.mp3');
        const command = FfmpegCommands.buildSplitToAudio(inputFile, segmentTime, outputFormat);
        await this.executeFluentCommand(command, {
            taskId,
            onProgress: onProgress ? onProgress : undefined
        });
        return await this.getOutputFiles(outputFolder, 'output_', '.mp3');
    }

    /**
     * 转换为 MP4
     */
    @WaitLock('ffmpeg')
    public async toMp4({
                           inputFile,
                           onProgress
                       }: {
        inputFile: string,
        onProgress?: (progress: number) => void
    }): Promise<string> {
        const outputFile = inputFile.replace(path.extname(inputFile), '.mp4');
        const command = FfmpegCommands.buildToMp4(inputFile, outputFile);

        await this.executeFluentCommand(command, {onProgress});
        return outputFile;
    }

    /**
     * MKV 转 MP4
     */
    @WaitLock('ffmpeg')
    public async mkvToMp4({
                              taskId,
                              inputFile,
                              onProgress
                          }: {
        taskId: number,
        inputFile: string,
        onProgress?: (progress: number) => void
    }): Promise<string> {
        const outputFile = inputFile.replace(path.extname(inputFile), '.mp4');
        const command = FfmpegCommands.buildMkvToMp4(inputFile, outputFile);

        await this.executeFluentCommand(command, {taskId, onProgress});
        return outputFile;
    }

    /**
     * 提取字幕
     */
    @WaitLock('ffmpeg')
    public async extractSubtitles({
                                      taskId,
                                      inputFile,
                                      onProgress,
                                      en
                                  }: {
        taskId: number,
        inputFile: string,
        onProgress?: (progress: number) => void,
        en: boolean
    }): Promise<string> {
        const outputFile = inputFile.replace(path.extname(inputFile), '.srt');
        const command = FfmpegCommands.buildExtractSubtitles(inputFile, outputFile, en);

        await this.executeFluentCommand(command, {taskId, onProgress});
        return outputFile;
    }

    /**
     * 裁剪视频
     */
    @WaitLock('ffmpeg')
    public async trimVideo(
        inputPath: string,
        startTime: number,
        endTime: number,
        outputPath: string
    ): Promise<void> {
        const command = FfmpegCommands.buildTrimVideo(inputPath, startTime, endTime, outputPath);
        await this.executeFluentCommand(command);
    }

    /**
     * 统一的 fluent-ffmpeg 执行方法
     */
    private async executeFluentCommand(
        command: ffmpeg.FfmpegCommand,
        options: {
            taskId?: number,
            onProgress?: (progress: number) => void
        } = {}
    ): Promise<void> {
        const {taskId, onProgress} = options;

        return new Promise<void>((resolve, reject) => {
            if (taskId) {
                this.dpTaskService.registerTask(taskId, new FfmpegTask(command));
            }

            command
                .on('start', (commandLine) => {
                    dpLog.log('Spawned Ffmpeg with command:', commandLine);
                })
                .on('progress', (progress) => {
                    if (progress.percent && onProgress) {
                        onProgress(Math.floor(Math.max(progress.percent, 0)));
                    }
                })
                .on('end', () => {
                    dpLog.log('Ffmpeg command completed successfully');
                    resolve();
                })
                .on('error', (error) => {
                    dpLog.error('An error occurred while executing ffmpeg command:', error);
                    reject(this.processError(error));
                })
                .run();
        });
    }

    /**
     * 统一的原生命令执行方法
     */
    private async executeRawCommand(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const ff = spawn(this.locationService.getThirdLibPath(ProgramType.FFMPEG), args);
            ff.on('close', (code) => {
                dpLog.log(`child process exited with code ${code}`);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg process exited with code ${code}`));
                }
            });
            ff.on('error', (error) => {
                dpLog.error('An error occurred while executing ffmpeg command:', error);
                reject(error);
            });
        });
    }

    /**
     * 统一的错误处理
     */
    private processError(error: Error): Error {
        if (error.message === 'ffmpeg was killed with signal SIGKILL') {
            return new CancelByUserError();
        }
        return error;
    }

    /**
     * 获取输出文件列表
     */
    private async getOutputFiles(outputFolder: string, prefix: string, ext?: string): Promise<string[]> {
        const files = await fs.promises.readdir(outputFolder);
        return files
            .filter(file => file.startsWith(prefix) && (ext ? file.endsWith(ext) : true))
            .sort()
            .map(file => path.join(outputFolder, file));
    }

    @postConstruct()
    private init() {
        ffmpeg.setFfmpegPath(this.locationService.getThirdLibPath(ProgramType.FFMPEG));
        ffmpeg.setFfprobePath(this.locationService.getThirdLibPath(ProgramType.FFPROBE));
    }
}
