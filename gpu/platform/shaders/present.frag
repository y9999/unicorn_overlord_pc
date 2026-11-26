// SPDX-License-Identifier: GPL-2.0-or-later
// The game's image into the frame the window shows. The source is read as linear light (an
// sRGB view, or decoded here for 10-bit sRGB buffers, which have no sRGB view) and the result
// is written sRGB encoded. A source larger than the frame is averaged over each frame pixel's
// footprint (a grid of up to 4x4 bilinear taps) instead of one tap that skips most of its
// pixels and shimmers; with sharpening on, that average is sharpened against its four
// neighbours, less where the local contrast is already high (after AMD's CAS).
#version 450
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 color;
layout(set = 0, binding = 0) uniform sampler2D source;
layout(push_constant) uniform Settings {
    uint srgb_input;
    float sharpen;   // 0 off .. 1 strongest
    // RenoDX HDR (presenter.cpp PresentPass::Settings).
    uint hdr_output; // 1: the frame is HDR10 (PQ, BT.2020)
    uint hdr_mode;   // 0 vanilla SDR look, 1 HDR, 2 highlights above SDR white in magenta
    float peak_nits;
    float game_nits;
    uint gamma22;    // SDR values decoded with gamma 2.2 (an SDR monitor) instead of the sRGB curve
} settings;

vec3 encode(vec3 c) {
    return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, lessThan(c, vec3(0.0031308)));
}
vec3 decode(vec3 c) {
    return mix(pow(max(c + 0.055, 0.0) / 1.055, vec3(2.4)), c / 12.92, lessThan(c, vec3(0.04045)));
}
// Values above 1.0 (16-bit float targets) and below 0 keep their sign and follow the curve.
vec3 decode_hdr(vec3 c) {
    if (settings.gamma22 != 0u) return sign(c) * pow(abs(c), vec3(2.2));
    return sign(c) * decode(abs(c));
}
vec4 tap(vec2 at) {
    vec4 c = texture(source, at);
    if (settings.srgb_input != 0u) c.rgb = settings.hdr_output != 0u ? decode_hdr(c.rgb) : decode(c.rgb);
    return c;
}

// ---- RenoDX HDR output ----
// Above SDR white (1.0) the brightest channel rolls off smoothly towards the peak (the slope is 1
// at SDR white, so nothing at or below it changes); hue is kept by scaling the three channels.
vec3 roll_off(vec3 c, float peak) {
    const float top = max(c.r, max(c.g, c.b));
    if (top <= 1.0 || peak <= 1.0) return c;
    const float room = peak - 1.0;
    const float rolled = 1.0 + room * (1.0 - exp(-(top - 1.0) / room));
    return c * (rolled / top);
}
vec3 bt709_to_bt2020(vec3 c) {
    return vec3(dot(vec3(0.6274040, 0.3292820, 0.0433136), c),
                dot(vec3(0.0690970, 0.9195400, 0.0113612), c),
                dot(vec3(0.0163916, 0.0880132, 0.8955950), c));
}
vec3 pq_encode(vec3 nits) {
    const float m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
    const vec3 p = pow(clamp(nits / 10000.0, 0.0, 1.0), vec3(m1));
    return pow((c1 + c2 * p) / (1.0 + c3 * p), vec3(m2));
}
vec3 encode_hdr10(vec3 linear) {
    if (any(isnan(linear)) || any(isinf(linear))) linear = vec3(0.0);
    vec3 c = max(linear, 0.0);
    if (settings.hdr_mode == 0u) {
        c = min(c, 1.0);                                       // vanilla: clipped as on an SDR screen
    } else if (settings.hdr_mode == 2u && max(c.r, max(c.g, c.b)) > 1.001) {
        c = vec3(1.0, 0.0, 1.0);                               // proof: data above SDR white
    } else {
        c = roll_off(c, settings.peak_nits / settings.game_nits);
    }
    return pq_encode(bt709_to_bt2020(c) * settings.game_nits);
}
vec4 area(vec2 center, vec2 footprint, ivec2 taps) {
    vec4 sum = vec4(0.0);
    for (int y = 0; y < taps.y; ++y)
        for (int x = 0; x < taps.x; ++x)
            sum += tap(center + footprint * ((vec2(x, y) + 0.5) / vec2(taps) - 0.5));
    return sum / float(taps.x * taps.y);
}

void main() {
    const vec2 pixel = abs(vec2(dFdx(uv).x, dFdy(uv).y));          // one frame pixel in uv
    const vec2 texels = pixel * vec2(textureSize(source, 0));        // source texels under it
    vec4 c;
    if (texels.x > 1.01 || texels.y > 1.01) {
        const ivec2 taps = clamp(ivec2(ceil(texels)), ivec2(1), ivec2(4));
        c = area(uv, pixel, taps);
        if (settings.sharpen > 0.0) {
            const vec3 m = c.rgb;
            const vec3 n = area(uv - vec2(0.0, pixel.y), pixel, taps).rgb;
            const vec3 s = area(uv + vec2(0.0, pixel.y), pixel, taps).rgb;
            const vec3 w = area(uv - vec2(pixel.x, 0.0), pixel, taps).rgb;
            const vec3 e = area(uv + vec2(pixel.x, 0.0), pixel, taps).rgb;
            const vec3 lo = min(m, min(min(n, s), min(w, e)));
            const vec3 hi = max(m, max(max(n, s), max(w, e)));
            const vec3 amount = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, 1e-4), 0.0, 1.0));
            const vec3 weight = amount * (-1.0 / mix(8.0, 5.0, settings.sharpen));
            c.rgb = (m + (n + s + w + e) * weight) / (1.0 + 4.0 * weight);
            c.rgb = settings.hdr_output != 0u ? max(c.rgb, 0.0) : clamp(c.rgb, 0.0, 1.0);
        }
    } else {
        c = tap(uv);
    }
    color = settings.hdr_output != 0u ? vec4(encode_hdr10(c.rgb), 1.0) : vec4(encode(max(c.rgb, 0.0)), 1.0);
}
