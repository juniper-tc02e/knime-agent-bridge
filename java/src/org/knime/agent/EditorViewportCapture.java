package org.knime.agent;

import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.eclipse.core.runtime.Platform;
import org.eclipse.swt.widgets.Control;
import org.eclipse.swt.widgets.Display;
import org.eclipse.ui.PlatformUI;

/** Optional exact Equo API; no browser script/evaluation or external debugger endpoint. */
final class EditorViewportCapture {
    static final String FRESHNESS="model-stable-render-unconfirmed";
    record Capture(byte[] png,ObjectNode identity){}
    record Pending(Object browser,CompletableFuture<byte[]> future,ObjectNode identity){}
    static Capture capture()throws Exception {
        var bundle=Platform.getBundle("com.equo.chromium");
        if(bundle==null||!bundle.getVersion().toString().equals("128.0.30"))throw new UnsupportedOperationException("Viewport requires com.equo.chromium 128.0.30");
        Class<?> api=bundle.loadClass("com.equo.chromium.ChromiumBrowser");
        Display display=PlatformUI.getWorkbench().getDisplay();
        if(Display.getCurrent()==display)throw new IllegalStateException("Viewport capture must not wait on SWT");
        CompletableFuture<Pending> selected=new CompletableFuture<>();
        display.asyncExec(()->{
            if(selected.isDone())return;
            try {
                Collection<?> browsers=(Collection<?>)api.getMethod("getAllBrowsers").invoke(null);
                List<Object> matches=new ArrayList<>();
                for(Object browser:browsers) {
                    String url=(String)api.getMethod("getUrl").invoke(browser);
                    if(url!=null&&url.split("[?#]",2)[0].equals("https://org.knime.ui.java/editor/index.html"))matches.add(browser);
                }
                if(matches.size()!=1)throw new IllegalStateException("Expected exactly one editor browser; found "+matches.size());
                Object browser=matches.get(0),component=api.getMethod("getUIComponent").invoke(browser);
                if(!(component instanceof Control control)||control.isDisposed()||!control.isVisible())throw new IllegalStateException("Editor browser does not have a visible SWT control");
                var size=control.getSize();if(size.x<1||size.y<1||((long)size.x)*size.y>16000000)throw new IllegalStateException("Editor bounds outside pixel budget");
                ObjectNode identity=BridgeActivator.JSON.createObjectNode().put("url",(String)api.getMethod("getUrl").invoke(browser))
                    .put("swtControlClass",control.getClass().getName()).put("swtControlIdentity",System.identityHashCode(control))
                    .put("cssWidth",size.x).put("cssHeight",size.y).put("coordinateMapping","unverified");
                @SuppressWarnings("unchecked") CompletableFuture<byte[]> future=(CompletableFuture<byte[]>)api.getMethod("captureScreenshot").invoke(browser);
                selected.complete(new Pending(browser,future,identity));
            }catch(Throwable e){selected.completeExceptionally(e);}
        });
        Pending pending;
        try{pending=selected.get(3,TimeUnit.SECONDS);}catch(Exception e){selected.cancel(false);throw e;}
        byte[] encoded=pending.future().get(20,TimeUnit.SECONDS);
        byte[] png=decode(encoded);int[] size=dimensions(png);
        pending.identity().put("width",size[0]).put("height",size[1]);return new Capture(png,pending.identity());
    }
    static byte[] decode(byte[] encoded) {
        if(encoded==null||encoded.length==0||encoded.length>6*1024*1024)throw new IllegalArgumentException("Empty or oversized Equo screenshot result");
        byte[] png;
        try{png=Base64.getDecoder().decode(new String(encoded,StandardCharsets.UTF_8));}
        catch(IllegalArgumentException e){throw new IllegalArgumentException("Equo screenshot is not UTF-8 base64",e);}
        dimensions(png);return png;
    }
    static int[] dimensions(byte[] png) {
        byte[] signature={(byte)137,80,78,71,13,10,26,10};
        if(png.length<33||png.length>4*1024*1024||!Arrays.equals(Arrays.copyOf(png,8),signature))throw new IllegalArgumentException("Invalid or oversized PNG signature");
        if(!new String(png,12,4,StandardCharsets.US_ASCII).equals("IHDR"))throw new IllegalArgumentException("PNG missing IHDR");
        ByteBuffer b=ByteBuffer.wrap(png).order(ByteOrder.BIG_ENDIAN);int width=b.getInt(16),height=b.getInt(20);
        if(width<=0||height<=0||(long)width*height>16000000)throw new IllegalArgumentException("PNG dimensions exceed 16 megapixels");
        return new int[]{width,height};
    }
}
