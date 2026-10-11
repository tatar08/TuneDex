// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ExplorerPlayerBar} from '@/app/app/player/ExplorerPlayerBar';
const api=vi.hoisted(()=>({stop:vi.fn(),togglePlayback:vi.fn(),toggleMute:vi.fn(),setVolume:vi.fn()}));
vi.mock('@/app/app/player/Player',()=>({usePlayer:()=>({...api,now:{name:'Test FM',url:'https://example.test/radio.mp3'},status:'playing',lang:'en',muted:false,volume:1,elapsed:10})}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks()});
it('keeps the timer active while a parent renders, cancels Off and stops at the chosen deadline',()=>{
 vi.useFakeTimers();const view=render(<ExplorerPlayerBar/>);
 const timer=screen.getByLabelText('Sleep timer');
 fireEvent.change(timer,{target:{value:'15'}});act(()=>vi.advanceTimersByTime(10*60_000));
 view.rerender(<ExplorerPlayerBar/>);act(()=>vi.advanceTimersByTime(5*60_000));expect(api.stop).toHaveBeenCalledTimes(1);
 fireEvent.change(timer,{target:{value:'30'}});act(()=>vi.advanceTimersByTime(20*60_000));fireEvent.change(timer,{target:{value:'0'}});act(()=>vi.advanceTimersByTime(30*60_000));expect(api.stop).toHaveBeenCalledTimes(1);
 fireEvent.change(timer,{target:{value:'60'}});view.unmount();act(()=>vi.advanceTimersByTime(60*60_000));expect(api.stop).toHaveBeenCalledTimes(1);
});
